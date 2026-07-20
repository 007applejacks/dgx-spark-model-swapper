"""Standard benchmark runner for GB10 Model Swapper.

Replaces the custom stability battery with industry-standard benchmarks:
- vLLM benchmark_serving.py: Online serving benchmark (latency, throughput, TTFT, concurrency)
- vLLM benchmark_throughput.py: Offline throughput benchmark (max throughput, no latency pressure)
- lm-eval-harness: Model quality/accuracy evaluation (MMLU, GSM8K, BBH, etc.)

Results are structured for the dashboard and comparable across models/runs.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx


@dataclass
class BenchmarkConfig:
    """Configuration for benchmark runs."""
    # Serving benchmark (online, with latency pressure)
    serving_requests: int = 100
    serving_concurrency: int = 4
    serving_input_len: int = 512
    serving_output_len: int = 128
    serving_dataset: str = "random"
    
    # Throughput benchmark (offline, max throughput)
    throughput_num_prompts: int = 50
    throughput_input_len: int = 1024
    throughput_output_len: int = 128
    
    # lm-eval-harness quality evaluation
    eval_tasks: list[str] = field(default_factory=lambda: [
        "mmlu", "gsm8k", "bbh", "hellaswag", "truthfulqa_mc2"
    ])
    eval_limit: int | None = 100  # Limit per task for speed; None = full
    eval_batch_size: int = 4
    
    # General
    timeout_serving: int = 600      # 10 min max for serving bench
    timeout_throughput: int = 300   # 5 min for throughput
    timeout_eval: int = 1200        # 20 min for quality eval


@dataclass
class BenchmarkResult:
    """Structured result from a benchmark run."""
    # Metadata
    model_id: str
    served_name: str
    timestamp: float
    config: BenchmarkConfig
    
    # vLLM serving benchmark results
    serving: dict[str, Any] = field(default_factory=dict)
    serving_raw: str = ""
    serving_error: str | None = None
    
    # vLLM throughput benchmark results
    throughput: dict[str, Any] = field(default_factory=dict)
    throughput_raw: str = ""
    throughput_error: str | None = None
    
    # lm-eval-harness results
    evaluation: dict[str, Any] = field(default_factory=dict)
    evaluation_raw: str = ""
    evaluation_error: str | None = None
    
    # GPU snapshot at end
    gpu_snapshot: dict[str, Any] = field(default_factory=dict)
    
    # Summary flags
    serving_passed: bool = False
    throughput_passed: bool = False
    evaluation_passed: bool = False
    
    @property
    def all_passed(self) -> bool:
        return (self.serving_passed and self.throughput_passed and 
                self.evaluation_passed)


def _parse_vllm_benchmark_output(output: str) -> dict[str, Any]:
    """Parse vLLM benchmark output (JSON or text) into structured dict."""
    # vLLM benchmarks can output JSON with --output-json
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        pass
    
    # Fallback: parse key metrics from text output
    result = {}
    for line in output.splitlines():
        line = line.strip()
        if "Throughput:" in line or "throughput:" in line.lower():
            # "Throughput: 123.4 tokens/s"
            parts = line.split(":")
            if len(parts) > 1:
                result["throughput_tok_s"] = _extract_float(parts[1])
        elif "Latency" in line and ("avg" in line.lower() or "mean" in line.lower()):
            # "Average Latency: 45.2 ms"
            result["avg_latency_ms"] = _extract_float(line)
        elif "TTFT" in line or "Time to first token" in line:
            result["ttft_ms"] = _extract_float(line)
        elif "P50" in line or "P90" in line or "P99" in line:
            # Percentile latencies
            key = line.split(":")[0].strip().lower().replace(" ", "_")
            result[key] = _extract_float(line)
        elif "Successful requests" in line:
            result["successful_requests"] = _extract_int(line)
        elif "Failed requests" in line:
            result["failed_requests"] = _extract_int(line)
    return result


def _extract_float(text: str) -> float | None:
    import re
    m = re.search(r"([\d.]+)", text)
    return float(m.group(1)) if m else None


def _extract_int(text: str) -> int | None:
    import re
    m = re.search(r"(\d+)", text)
    return int(m.group(1)) if m else None


def _parse_lm_eval_output(output: str) -> dict[str, Any]:
    """Parse lm-eval-harness output into structured results."""
    # lm-eval outputs JSON to stdout when --output_path is used, or prints summary
    result = {"tasks": {}, "summary": {}}
    
    # Try to find JSON in output
    try:
        # Look for the final JSON summary
        for line in output.splitlines():
            line = line.strip()
            if line.startswith("{") and "results" in line:
                data = json.loads(line)
                result = data
                break
    except json.JSONDecodeError:
        pass
    
    # Also parse text summary for key metrics
    for line in output.splitlines():
        line = line.strip()
        if "|" in line and any(t in line for t in ["acc", "f1", "em", "mc"]):
            # Table row like: "| mmlu | acc | 0.7234 |"
            parts = [p.strip() for p in line.split("|") if p.strip()]
            if len(parts) >= 3:
                task, metric, value = parts[0], parts[1], parts[2]
                try:
                    result.setdefault("tasks", {})[task] = {metric: float(value)}
                except ValueError:
                    pass
    
    return result


def _docker_exec_container(model: str) -> str:
    """swap-vllm-<served-name> is the project-wide container naming convention (see
    manifests/containers.env, gb10-swap.sh) — no separate lookup needed."""
    return f"swap-vllm-{model}"


def _vllm_module_cmd(container: str, module: str, args: list[str]) -> list[str]:
    """vllm (the pip package, including vllm.benchmarks.*) only exists inside the serving
    container's own image — swap-ui's venv deliberately stays lightweight (fastapi/uvicorn/httpx +
    lm-eval/datasets) and never installs vllm itself. Run the benchmark script via `docker exec`
    into the already-running container instead, where `--base-url http://localhost:PORT` resolves
    correctly (docker exec shares the container's network namespace, so localhost is itself)."""
    return ["docker", "exec", "-e", "VLLM_USE_V1=1", container, "python3", "-m", module, *args]


async def run_vllm_serving_benchmark(
    base_url: str,
    model: str,
    config: BenchmarkConfig,
    gpu_snapshot_fn,
) -> tuple[dict[str, Any], str, str | None]:
    """Run vLLM benchmark_serving.py against the running server."""
    # vLLM's benchmark_serving.py supports --base-url for remote servers
    # We need to run it with the model name as served on the server
    cmd = _vllm_module_cmd(_docker_exec_container(model), "vllm.benchmarks.benchmark_serving", [
        "--base-url", base_url,
        "--model", model,
        "--num-prompts", str(config.serving_requests),
        "--max-concurrency", str(config.serving_concurrency),
        "--input-len", str(config.serving_input_len),
        "--output-len", str(config.serving_output_len),
        "--dataset-name", config.serving_dataset,
        "--output-json", "-",  # stdout
    ])

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=config.timeout_serving
        )
        raw = stdout.decode(errors="replace") + "\n" + stderr.decode(errors="replace")
        parsed = _parse_vllm_benchmark_output(raw)
        parsed["gpu"] = gpu_snapshot_fn()
        return parsed, raw, None
    except asyncio.TimeoutError:
        return {}, "", f"Serving benchmark timed out after {config.timeout_serving}s"
    except Exception as e:
        return {}, "", f"Serving benchmark failed: {e}"


async def run_vllm_throughput_benchmark(
    base_url: str,
    model: str,
    config: BenchmarkConfig,
    gpu_snapshot_fn,
) -> tuple[dict[str, Any], str, str | None]:
    """Run vLLM benchmark_throughput.py against the running server."""
    cmd = _vllm_module_cmd(_docker_exec_container(model), "vllm.benchmarks.benchmark_throughput", [
        "--base-url", base_url,
        "--model", model,
        "--num-prompts", str(config.throughput_num_prompts),
        "--input-len", str(config.throughput_input_len),
        "--output-len", str(config.throughput_output_len),
        "--output-json", "-",
    ])

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=config.timeout_throughput
        )
        raw = stdout.decode(errors="replace") + "\n" + stderr.decode(errors="replace")
        parsed = _parse_vllm_benchmark_output(raw)
        parsed["gpu"] = gpu_snapshot_fn()
        return parsed, raw, None
    except asyncio.TimeoutError:
        return {}, "", f"Throughput benchmark timed out after {config.timeout_throughput}s"
    except Exception as e:
        return {}, "", f"Throughput benchmark failed: {e}"


async def run_lm_eval_harness(
    base_url: str,
    model: str,
    config: BenchmarkConfig,
    gpu_snapshot_fn,
) -> tuple[dict[str, Any], str, str | None]:
    """Run lm-eval-harness against the vLLM server via OpenAI-compatible API.
    
    Uses the `local-completions` model type with the OpenAI-compatible endpoint.
    """
    # lm-eval can use local-completions with a custom endpoint
    # We'll use the vLLM server's /v1/completions endpoint
    tasks = ",".join(config.eval_tasks)
    
    cmd = [
        sys.executable, "-m", "lm_eval",
        "--model", "local-completions",
        "--model_args", f"base_url={base_url}/v1,model={model},max_gen_toks={config.serving_output_len},batch_size={config.eval_batch_size}",
        "--tasks", tasks,
        "--device", "cuda",
        "--output_path", "-",  # stdout
    ]
    
    if config.eval_limit:
        cmd += ["--limit", str(config.eval_limit)]
    
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "VLLM_USE_V1": "1"},
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=config.timeout_eval
        )
        raw = stdout.decode(errors="replace") + "\n" + stderr.decode(errors="replace")
        parsed = _parse_lm_eval_output(raw)
        parsed["gpu"] = gpu_snapshot_fn()
        return parsed, raw, None
    except asyncio.TimeoutError:
        return {}, "", f"lm-eval timed out after {config.timeout_eval}s"
    except Exception as e:
        return {}, "", f"lm-eval failed: {e}"


async def run_full_benchmark_suite(
    base_url: str,
    model: str,
    model_id: str,
    config: BenchmarkConfig | None = None,
    gpu_snapshot_fn=lambda: {},
    on_progress: callable = None,
) -> BenchmarkResult:
    """Run the complete standard benchmark suite.
    
    Args:
        base_url: Base URL of the vLLM server (e.g., http://localhost:8002)
        model: Model name as served (SERVED_NAME)
        model_id: Registry model ID
        config: Benchmark configuration (uses defaults if None)
        gpu_snapshot_fn: Callable returning GPU telemetry dict
        on_progress: Callback(state_dict) for live progress updates
    
    Returns:
        BenchmarkResult with all three benchmark results
    """
    config = config or BenchmarkConfig()
    result = BenchmarkResult(
        model_id=model_id,
        served_name=model,
        timestamp=time.time(),
        config=config,
    )
    
    state = {"phase": "starting", "result": result}
    
    # 1. Serving benchmark (online, latency-sensitive)
    if on_progress:
        state["phase"] = "serving"
        on_progress(state)
    
    serving = await run_vllm_serving_benchmark(base_url, model, config, gpu_snapshot_fn)
    result.serving, result.serving_raw, result.serving_error = serving
    result.serving_passed = result.serving_error is None and result.serving.get("failed_requests", 0) == 0
    
    if on_progress:
        on_progress(state)
    
    # 2. Throughput benchmark (offline, max throughput)
    if on_progress:
        state["phase"] = "throughput"
        on_progress(state)
    
    throughput = await run_vllm_throughput_benchmark(base_url, model, config, gpu_snapshot_fn)
    result.throughput, result.throughput_raw, result.throughput_error = throughput
    result.throughput_passed = result.throughput_error is None
    
    if on_progress:
        on_progress(state)
    
    # 3. Quality evaluation (lm-eval-harness)
    if on_progress:
        state["phase"] = "evaluation"
        on_progress(state)
    
    evaluation = await run_lm_eval_harness(base_url, model, config, gpu_snapshot_fn)
    result.evaluation, result.evaluation_raw, result.evaluation_error = evaluation
    result.evaluation_passed = result.evaluation_error is None
    
    # Final GPU snapshot
    result.gpu_snapshot = gpu_snapshot_fn()
    
    if on_progress:
        state["phase"] = "complete"
        on_progress(state)
    
    return result


def benchmark_result_to_dict(result: BenchmarkResult) -> dict[str, Any]:
    """Convert BenchmarkResult to JSON-serializable dict for API/UI."""
    return {
        "model_id": result.model_id,
        "served_name": result.served_name,
        "timestamp": result.timestamp,
        "config": {
            "serving_requests": result.config.serving_requests,
            "serving_concurrency": result.config.serving_concurrency,
            "serving_input_len": result.config.serving_input_len,
            "serving_output_len": result.config.serving_output_len,
            "throughput_num_prompts": result.config.throughput_num_prompts,
            "throughput_input_len": result.config.throughput_input_len,
            "throughput_output_len": result.config.throughput_output_len,
            "eval_tasks": result.config.eval_tasks,
            "eval_limit": result.config.eval_limit,
        },
        "serving": result.serving,
        "serving_raw": result.serving_raw,
        "serving_error": result.serving_error,
        "serving_passed": result.serving_passed,
        "throughput": result.throughput,
        "throughput_raw": result.throughput_raw,
        "throughput_error": result.throughput_error,
        "throughput_passed": result.throughput_passed,
        "evaluation": result.evaluation,
        "evaluation_raw": result.evaluation_raw,
        "evaluation_error": result.evaluation_error,
        "evaluation_passed": result.evaluation_passed,
        "gpu_snapshot": result.gpu_snapshot,
        "all_passed": result.all_passed,
    }