"""Standard benchmark runner for GB10 Model Swapper.

Two distinct things live here, deliberately kept apart:

1. The SAFE suite (`run_full_benchmark_suite`) — vLLM's own online serving benchmark
   (`vllm bench serve`) plus lm-eval-harness quality evaluation, both hitting the
   already-running server over HTTP. Neither touches what's loaded; safe to run any time,
   same as the stability battery it replaces.
2. `run_offline_throughput_benchmark` — vLLM's offline throughput benchmark
   (`vllm bench throughput`) has no remote-server backend at all (`--backend
   {vllm,hf,mii,vllm-chat}` — all local-engine, none HTTP); it always loads its own model
   instance. Running it while the same model is already loaded would try to double-allocate
   GPU memory on a box with no MIG isolation that wedges (reboot-only recovery) on OOM. This
   is NOT part of the safe suite — callers MUST unload the current model, drain the GPU, run
   this, then reload the original model. app.py's dedicated /api/benchmark/throughput
   endpoint owns that orchestration and the explicit user-facing warning; this module only
   runs the one disruptive command.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class BenchmarkConfig:
    """Configuration for the safe (serving + eval) benchmark suite."""
    # Serving benchmark (online, with latency pressure)
    serving_requests: int = 100
    serving_concurrency: int = 4
    serving_input_len: int = 512
    serving_output_len: int = 128
    serving_dataset: str = "random"

    # lm-eval-harness quality evaluation
    eval_tasks: list[str] = field(default_factory=lambda: [
        "mmlu", "gsm8k", "bbh", "hellaswag", "truthfulqa_mc2"
    ])
    eval_limit: int | None = 100  # Limit per task for speed; None = full
    eval_batch_size: int = 4

    # General
    timeout_serving: int = 600      # 10 min max for serving bench
    timeout_eval: int = 1200        # 20 min for quality eval


@dataclass
class BenchmarkResult:
    """Structured result from a safe-suite run."""
    model_id: str
    served_name: str
    timestamp: float
    config: BenchmarkConfig

    serving: dict[str, Any] = field(default_factory=dict)
    serving_raw: str = ""
    serving_error: str | None = None

    evaluation: dict[str, Any] = field(default_factory=dict)
    evaluation_raw: str = ""
    evaluation_error: str | None = None

    gpu_snapshot: dict[str, Any] = field(default_factory=dict)

    serving_passed: bool = False
    evaluation_passed: bool = False

    @property
    def all_passed(self) -> bool:
        return self.serving_passed and self.evaluation_passed


@dataclass
class ThroughputResult:
    """Structured result from the standalone (disruptive) offline throughput benchmark."""
    model_id: str
    model_repo: str
    timestamp: float
    throughput_num_prompts: int
    throughput_input_len: int
    throughput_output_len: int

    throughput: dict[str, Any] = field(default_factory=dict)
    throughput_raw: str = ""
    throughput_error: str | None = None
    throughput_passed: bool = False

    gpu_snapshot: dict[str, Any] = field(default_factory=dict)


def _parse_vllm_benchmark_output(output: str) -> dict[str, Any]:
    """Parse vLLM benchmark output (JSON or text) into structured dict."""
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        pass

    # Fallback: parse key metrics from the printed summary table (neither `vllm bench serve` nor
    # `vllm bench throughput` support an --output-json-to-stdout flag; --save-result writes a file
    # instead, which we deliberately don't chase — the printed summary already has what we show).
    result = {}
    for line in output.splitlines():
        line = line.strip()
        if "Throughput:" in line or "throughput:" in line.lower():
            parts = line.split(":")
            if len(parts) > 1:
                result["throughput_tok_s"] = _extract_float(parts[1])
        elif "Latency" in line and ("avg" in line.lower() or "mean" in line.lower()):
            result["avg_latency_ms"] = _extract_float(line)
        elif "TTFT" in line or "Time to first token" in line:
            result["ttft_ms"] = _extract_float(line)
        elif "P50" in line or "P90" in line or "P99" in line:
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
    result = {"tasks": {}, "summary": {}}
    try:
        for line in output.splitlines():
            line = line.strip()
            if line.startswith("{") and "results" in line:
                result = json.loads(line)
                break
    except json.JSONDecodeError:
        pass

    for line in output.splitlines():
        line = line.strip()
        if "|" in line and any(t in line for t in ["acc", "f1", "em", "mc"]):
            parts = [p.strip() for p in line.split("|") if p.strip()]
            if len(parts) >= 3:
                task, metric, value = parts[0], parts[1], parts[2]
                try:
                    result.setdefault("tasks", {})[task] = {metric: float(value)}
                except ValueError:
                    pass

    return result


def _serving_container(served_name: str) -> str:
    """swap-vllm-<served-name> is the project-wide container naming convention (see
    manifests/containers.env, gb10-swap.sh) — no separate lookup needed."""
    return f"swap-vllm-{served_name}"


async def run_vllm_serving_benchmark(
    base_url: str,
    model: str,
    config: BenchmarkConfig,
    gpu_snapshot_fn,
) -> tuple[dict[str, Any], str, str | None]:
    """Run `vllm bench serve` (vLLM 0.24's online serving benchmark CLI) against the already-
    running server, inside its own container via `docker exec` — vllm itself only exists in the
    serving image, not swap-ui's own lightweight venv. `docker exec` shares the container's network
    namespace, so --base-url http://localhost:PORT correctly reaches the server running in it."""
    cmd = [
        "docker", "exec", "-e", "VLLM_USE_V1=1", _serving_container(model),
        "vllm", "bench", "serve",
        "--base-url", base_url,
        # No --model: that's the HF repo/tokenizer path to vLLM's bench tool, not just a label —
        # passing the served name here made it try (and 404) fetching "nemotron-cascade-2-30b-a3b"
        # from huggingface.co. Omitting it makes the tool fetch the actual served model from the
        # server's own /v1/models, which is exactly what we want (whatever's currently loaded).
        "--num-prompts", str(config.serving_requests),
        "--max-concurrency", str(config.serving_concurrency),
        "--input-len", str(config.serving_input_len),
        "--output-len", str(config.serving_output_len),
        "--dataset-name", config.serving_dataset,
    ]

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
        if proc.returncode != 0:
            return {}, raw, f"vllm bench serve exited {proc.returncode}"
        parsed = _parse_vllm_benchmark_output(raw)
        parsed["gpu"] = gpu_snapshot_fn()
        return parsed, raw, None
    except asyncio.TimeoutError:
        return {}, "", f"Serving benchmark timed out after {config.timeout_serving}s"
    except Exception as e:
        return {}, "", f"Serving benchmark failed: {e}"


async def run_lm_eval_harness(
    base_url: str,
    model: str,
    model_repo: str,
    config: BenchmarkConfig,
    gpu_snapshot_fn,
) -> tuple[dict[str, Any], str, str | None]:
    """Run lm-eval-harness against the vLLM server via its OpenAI-compatible API, using the
    `local-completions` model type — an HTTP client, not a local model load, so this runs safely
    in swap-ui's own venv without touching the GPU itself.

    `model=` in --model_args is the API-request identifier (the SERVED_NAME) — lm-eval sends it
    verbatim in each request's "model" field. That's a completely separate thing from the
    tokenizer lm-eval loads locally to count/truncate tokens ("Remote tokenizer not supported"),
    which needs the actual HF repo id (`tokenizer=`) — passing SERVED_NAME there 404s trying to
    fetch e.g. "nemotron-cascade-2-30b-a3b" from huggingface.co.
    """
    tasks = ",".join(config.eval_tasks)

    cmd = [
        sys.executable, "-m", "lm_eval",
        "--model", "local-completions",
        # batch_size is passed via lm-eval's own --batch_size flag below, NOT here too — lm-eval's
        # CLI already forwards --batch_size into the model constructor, and having it in both
        # places raised "got multiple values for keyword argument 'batch_size'".
        "--model_args",
        # base_url must be the full completions endpoint, not just the API root — the class
        # default is "https://api.openai.com/v1/completions"; passing just ".../v1" 404s since
        # lm-eval doesn't append "/completions" itself.
        f"base_url={base_url}/v1/completions,model={model},tokenizer={model_repo},max_gen_toks={config.serving_output_len}",
        "--tasks", tasks,
        "--batch_size", str(config.eval_batch_size),
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
        if proc.returncode != 0:
            return {}, raw, f"lm-eval exited {proc.returncode}"
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
    model_repo: str,
    config: BenchmarkConfig | None = None,
    gpu_snapshot_fn=lambda: {},
    on_progress: callable = None,
) -> BenchmarkResult:
    """Run the safe benchmark suite: serving + quality eval. Both hit the already-running
    server over HTTP — neither touches what's loaded, so this never disrupts serving."""
    config = config or BenchmarkConfig()
    result = BenchmarkResult(
        model_id=model_id,
        served_name=model,
        timestamp=time.time(),
        config=config,
    )

    state = {"phase": "starting", "result": result}

    if on_progress:
        state["phase"] = "serving"
        on_progress(state)

    serving = await run_vllm_serving_benchmark(base_url, model, config, gpu_snapshot_fn)
    result.serving, result.serving_raw, result.serving_error = serving
    result.serving_passed = result.serving_error is None and result.serving.get("failed_requests", 0) == 0

    if on_progress:
        on_progress(state)

    if on_progress:
        state["phase"] = "evaluation"
        on_progress(state)

    evaluation = await run_lm_eval_harness(base_url, model, model_repo, config, gpu_snapshot_fn)
    result.evaluation, result.evaluation_raw, result.evaluation_error = evaluation
    result.evaluation_passed = result.evaluation_error is None

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
            "eval_tasks": result.config.eval_tasks,
            "eval_limit": result.config.eval_limit,
        },
        "serving": result.serving,
        "serving_raw": result.serving_raw,
        "serving_error": result.serving_error,
        "serving_passed": result.serving_passed,
        "evaluation": result.evaluation,
        "evaluation_raw": result.evaluation_raw,
        "evaluation_error": result.evaluation_error,
        "evaluation_passed": result.evaluation_passed,
        "gpu_snapshot": result.gpu_snapshot,
        "all_passed": result.all_passed,
    }


# --- offline throughput benchmark (disruptive — see module docstring) --------------------------

async def run_offline_throughput_benchmark(
    vllm_image: str,
    hf_cache_vol: str,
    model_repo: str,
    model_id: str,
    num_prompts: int = 50,
    input_len: int = 1024,
    output_len: int = 128,
    timeout_s: int = 600,
    gpu_snapshot_fn=lambda: {},
) -> ThroughputResult:
    """Run `vllm bench throughput` (offline, own model instance) in a throwaway container.

    Caller MUST have already stopped whatever's currently loaded and confirmed the GPU is idle —
    this does not check. `--rm` removes the container (and its GPU memory) the moment the command
    exits, whether it succeeds or fails.
    """
    result = ThroughputResult(
        model_id=model_id,
        model_repo=model_repo,
        timestamp=time.time(),
        throughput_num_prompts=num_prompts,
        throughput_input_len=input_len,
        throughput_output_len=output_len,
    )

    cmd = [
        "docker", "run", "--rm", "--gpus", "all", "--ipc=host",
        "--ulimit", "memlock=-1", "--ulimit", "stack=67108864",
        "-v", f"{hf_cache_vol}:/root/.cache/huggingface",
        "--entrypoint", "vllm",
        vllm_image,
        "bench", "throughput",
        "--backend", "vllm",
        "--model", model_repo,
        "--trust-remote-code",
        "--num-prompts", str(num_prompts),
        "--input-len", str(input_len),
        "--output-len", str(output_len),
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        raw = stdout.decode(errors="replace") + "\n" + stderr.decode(errors="replace")
        result.throughput_raw = raw
        if proc.returncode != 0:
            result.throughput_error = f"vllm bench throughput exited {proc.returncode}"
        else:
            result.throughput = _parse_vllm_benchmark_output(raw)
            result.throughput_passed = True
    except asyncio.TimeoutError:
        result.throughput_error = f"Throughput benchmark timed out after {timeout_s}s"
    except Exception as e:
        result.throughput_error = f"Throughput benchmark failed: {e}"

    result.gpu_snapshot = gpu_snapshot_fn()
    return result


def throughput_result_to_dict(result: ThroughputResult) -> dict[str, Any]:
    return {
        "model_id": result.model_id,
        "model_repo": result.model_repo,
        "timestamp": result.timestamp,
        "throughput_num_prompts": result.throughput_num_prompts,
        "throughput_input_len": result.throughput_input_len,
        "throughput_output_len": result.throughput_output_len,
        "throughput": result.throughput,
        "throughput_raw": result.throughput_raw,
        "throughput_error": result.throughput_error,
        "throughput_passed": result.throughput_passed,
        "gpu_snapshot": result.gpu_snapshot,
    }
