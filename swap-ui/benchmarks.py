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
import glob
import json
import os
import re
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class BenchmarkConfig:
    """Configuration for the safe (serving + eval) benchmark suite."""
    # Serving benchmark (online, with latency pressure). 100 -> 10 -> 30: 10 was a quick sanity
    # check (does the endpoint serve correctly under a little concurrency) but its throughput
    # number swung 3x run-to-run on identical config (17.98 vs 58.82 tok/s, same image, back to
    # back) — too noisy to mean anything. 30 trades a bit more runtime for a less useless number;
    # still not a statistically rigorous latency study, just less of a coin flip.
    serving_requests: int = 30
    serving_concurrency: int = 4
    serving_input_len: int = 512
    serving_output_len: int = 128
    serving_dataset: str = "random"

    # lm-eval-harness quality evaluation
    eval_tasks: list[str] = field(default_factory=lambda: [
        "mmlu", "gsm8k", "bbh", "hellaswag", "truthfulqa_mc2"
    ])
    # 100/task (5 tasks) is ~24k loglikelihood requests — genuinely took over an hour against a
    # model capped at --max-num-seqs 4 (num_concurrent can't outrun the server's own concurrency
    # limit). Even 20/task took ~50 minutes end-to-end. 5/task is the practical floor for this
    # still being a meaningful smoke-test signal rather than pure noise, while running in minutes
    # instead of the better part of an hour.
    eval_limit: int | None = 5  # Limit per task for speed; None = full
    # 4 -> 2 (2026-07-21): eval_batch_size sets lm-eval's num_concurrent, i.e. how many
    # loglikelihood requests (each computing prompt_logprobs over a full few-shot prompt) run at
    # once. On nemotron3-super-120b -- a 75GB model with only ~5x KV-cache concurrency headroom
    # at GPU_UTIL=0.80 -- 4 concurrent eval requests pushed the engine into repeated NVRM
    # "Out of memory" driver errors and eventually a silent EngineCore crash mid-eval (no Python
    # exception, just gone). 2 is safer margin; no config knob for a lighter setting on just the
    # tight models yet, so this is a global default change.
    eval_batch_size: int = 2

    # General
    timeout_serving: int = 600      # 10 min max for serving bench
    timeout_eval: int = 3600        # 60 min for quality eval — ~tens of thousands of
                                     # loglikelihood requests even at eval_limit=100/task;
                                     # num_concurrent (see run_lm_eval_harness) cuts wall time
                                     # but this still needs real margin, not just the old 20 min


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
        # `vllm bench serve`'s exact summary format (from vllm/benchmarks/serve.py's own
        # "{:<40} {:<10.2f}".format(...) print calls — read from source, not guessed, after the
        # requests/s-vs-tok/s mixup below). "Output token throughput (tok/s):" only appears in the
        # generate-mode this suite runs; the label never contains a bare "Throughput:" substring,
        # so this branch and the `vllm bench throughput` branch below never collide.
        if "Output token throughput (tok/s):" in line:
            v = _extract_float(line.split(":", 1)[1])
            if v is not None:
                result["throughput_tok_s"] = v
        elif "Total token throughput (tok/s):" in line:
            v = _extract_float(line.split(":", 1)[1])
            if v is not None:
                result["total_tokens_per_s"] = v
        elif "Request throughput (req/s):" in line:
            v = _extract_float(line.split(":", 1)[1])
            if v is not None:
                result["requests_per_s"] = v
        elif "Throughput:" in line:
            # `vllm bench throughput`'s (offline) summary line has THREE numbers on one line, e.g.:
            #   "Throughput: 0.27 requests/s, 311.76 total tokens/s, 34.64 output tokens/s"
            # Naively taking the first float after "Throughput:" (the old code) silently grabbed
            # requests/s instead of the actual generation rate — a real bug caught because 0.27
            # tok/s was implausibly ~100x slower than this same model class gets elsewhere.
            m = re.search(
                r"Throughput:\s*([\d.]+)\s*requests/s,\s*([\d.]+)\s*total tokens/s,"
                r"\s*([\d.]+)\s*output tokens/s",
                line,
            )
            if m:
                result["requests_per_s"] = float(m.group(1))
                result["total_tokens_per_s"] = float(m.group(2))
                result["throughput_tok_s"] = float(m.group(3))
            else:
                # Unknown/older format — fall back to the last number on the line (usually the
                # most specific/rightmost metric in these summaries) rather than the first, which
                # is what caused this bug in the first place.
                nums = re.findall(r"[\d.]+", line)
                if nums:
                    result["throughput_tok_s"] = float(nums[-1])
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


def _parse_lm_eval_results_file(results_dir: str) -> dict[str, Any]:
    """lm-eval writes results_<timestamp>.json under <output_path>/<model_name_sanitized>/ —
    read the actual scores back from there. `--output_path -` does NOT mean stdout in this
    lm-eval version: it creates a literal directory named "-" and writes the JSON there instead,
    printing only progress bars and a "Saving results aggregated" line to stdout/stderr — nothing
    resembling a parseable table or JSON ever reaches the subprocess's captured output."""
    matches = glob.glob(os.path.join(results_dir, "**", "results_*.json"), recursive=True)
    if not matches:
        return {"tasks": {}, "summary": {}}
    with open(max(matches, key=os.path.getmtime)) as f:
        data = json.load(f)
    tasks: dict[str, dict[str, float]] = {}
    for task_name, metrics in (data.get("results") or {}).items():
        tasks[task_name] = {
            k: v for k, v in metrics.items()
            if isinstance(v, (int, float)) and not k.endswith("_stderr,none") and k != "sample_len"
        }
    return {"tasks": tasks, "summary": {}}


def _serving_container(served_name: str) -> str:
    """swap-vllm-<served-name> is the project-wide container naming convention (see
    manifests/containers.env, gb10-swap.sh) — no separate lookup needed."""
    return f"swap-vllm-{served_name}"


_TQDM_SPLIT_RE = re.compile(r"[\r\n]")


async def _run_streaming(
    cmd: list[str],
    timeout_s: int,
    on_progress_line: Callable[[str], None] | None = None,
    env: dict[str, str] | None = None,
) -> tuple[bool, str]:
    """Run a subprocess, live-streaming its combined stdout+stderr instead of blocking on
    communicate() until it exits — tqdm-style progress bars (vllm bench serve, lm-eval) rewrite
    the same line via bare \\r with no trailing \\n, so a plain readline()-based read would only
    ever see the FINAL state once the process closes its pipes, not the live percentage. Splits
    the growing buffer on \\r/\\n and reports whatever's after the last split as the current
    progress line — the same "tail the tqdm line" approach gb10-lib.sh's wait_health already uses
    for swap jobs, just applied to a live subprocess instead of `docker logs`.

    Returns (ok, raw_combined_output). Kills the process on timeout (asyncio.wait_for cancelling
    the read loop does NOT kill the underlying OS process on its own).
    """
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=env,
    )
    chunks: list[bytes] = []
    tail = ""

    async def _pump() -> None:
        nonlocal tail
        assert proc.stdout is not None
        while True:
            chunk = await proc.stdout.read(4096)
            if not chunk:
                break
            chunks.append(chunk)
            tail = (tail + chunk.decode(errors="replace"))[-4096:]
            if on_progress_line:
                # split()[-1] alone breaks when a chunk happens to end exactly on \r/\n (a real
                # bug caught by testing this before deploying): that trailing delimiter produces
                # an empty string as the final element, silently swallowing whatever line just
                # completed. Take the last NON-empty segment instead.
                parts = [p.strip() for p in _TQDM_SPLIT_RE.split(tail) if p.strip()]
                if parts:
                    on_progress_line(parts[-1])

    try:
        await asyncio.wait_for(_pump(), timeout=timeout_s)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise
    await proc.wait()
    return proc.returncode == 0, b"".join(chunks).decode(errors="replace")


async def run_vllm_serving_benchmark(
    base_url: str,
    model: str,
    model_repo: str,
    config: BenchmarkConfig,
    on_progress_line: Callable[[str], None] | None = None,
) -> tuple[dict[str, Any], str, str | None]:
    """Run `vllm bench serve` (vLLM 0.24's online serving benchmark CLI) against the already-
    running server, inside its own container via `docker exec` — vllm itself only exists in the
    serving image, not swap-ui's own lightweight venv. `docker exec` shares the container's network
    namespace, so --base-url http://localhost:PORT correctly reaches the server running in it."""
    cmd = [
        "docker", "exec", "-e", "VLLM_USE_V1=1", _serving_container(model),
        "vllm", "bench", "serve",
        "--base-url", base_url,
        # No --model: that's the served-model label used in each request, not the tokenizer path —
        # passing the served name here made it try (and 404) fetching "nemotron-cascade-2-30b-a3b"
        # from huggingface.co. Omitting it makes the tool fetch the actual served model from the
        # server's own /v1/models for request payloads, which is exactly what we want.
        # --tokenizer IS the real HF repo, though (a separate concern from --model): per vLLM's own
        # source (vllm/benchmarks/serve.py), the "Output/Total token throughput (tok/s):" summary
        # lines only print `if tokenizer:` — without this, the serving benchmark "passed" but
        # reported zero throughput metrics at all, silently.
        "--tokenizer", model_repo,
        "--num-prompts", str(config.serving_requests),
        "--max-concurrency", str(config.serving_concurrency),
        "--input-len", str(config.serving_input_len),
        "--output-len", str(config.serving_output_len),
        "--dataset-name", config.serving_dataset,
    ]

    try:
        ok, raw = await _run_streaming(cmd, config.timeout_serving, on_progress_line)
        if not ok:
            return {}, raw, "vllm bench serve failed (non-zero exit)"
        parsed = _parse_vllm_benchmark_output(raw)
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
    on_progress_line: Callable[[str], None] | None = None,
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
    results_dir = tempfile.mkdtemp(prefix="lm-eval-results-")

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
        # num_concurrent defaults to 1 (fully sequential) — a real eval run is ~tens of thousands
        # of loglikelihood requests (one per multiple-choice option), which timed out after 20
        # real minutes at num_concurrent=1. Reuse eval_batch_size as the concurrency level too.
        f"base_url={base_url}/v1/completions,model={model},tokenizer={model_repo},"
        f"max_gen_toks={config.serving_output_len},num_concurrent={config.eval_batch_size}",
        "--tasks", tasks,
        "--batch_size", str(config.eval_batch_size),
        # A real directory, NOT "-" — lm-eval doesn't treat "-" as stdout, it creates a literal
        # directory named "-" and writes the results JSON there, printing nothing parseable to
        # stdout/stderr. Read the file back after the process exits instead.
        "--output_path", results_dir,
    ]

    if config.eval_limit:
        cmd += ["--limit", str(config.eval_limit)]

    try:
        ok, raw = await _run_streaming(
            cmd, config.timeout_eval, on_progress_line, env={**os.environ, "VLLM_USE_V1": "1"},
        )
        if not ok:
            return {}, raw, "lm-eval failed (non-zero exit)"
        parsed = _parse_lm_eval_results_file(results_dir)
        return parsed, raw, None
    except asyncio.TimeoutError:
        return {}, "", f"lm-eval timed out after {config.timeout_eval}s"
    except Exception as e:
        return {}, "", f"lm-eval failed: {e}"
    finally:
        shutil.rmtree(results_dir, ignore_errors=True)


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

    state = {"phase": "starting", "result": result, "progress": None}

    def _progress_cb(line: str) -> None:
        # Fires on every tqdm \r update (potentially many times a second) — cheap dict
        # construction, no I/O, so this is fine to call at that rate.
        state["progress"] = line
        if on_progress:
            on_progress(state)

    if on_progress:
        state["phase"] = "serving"
        state["progress"] = None
        on_progress(state)

    serving = await run_vllm_serving_benchmark(
        base_url, model, model_repo, config, on_progress_line=_progress_cb,
    )
    result.serving, result.serving_raw, result.serving_error = serving
    result.serving_passed = result.serving_error is None and result.serving.get("failed_requests", 0) == 0

    if on_progress:
        on_progress(state)

    if on_progress:
        state["phase"] = "evaluation"
        state["progress"] = None
        on_progress(state)

    evaluation = await run_lm_eval_harness(
        base_url, model, model_repo, config, on_progress_line=_progress_cb,
    )
    result.evaluation, result.evaluation_raw, result.evaluation_error = evaluation
    result.evaluation_passed = result.evaluation_error is None

    result.gpu_snapshot = gpu_snapshot_fn()

    if on_progress:
        state["phase"] = "complete"
        state["progress"] = None
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
    num_prompts: int = 10,  # kept minimal — this is disruptive (model offline for the duration)
    input_len: int = 1024,
    output_len: int = 128,
    timeout_s: int = 600,
    gpu_snapshot_fn=lambda: {},
    on_progress_line: Callable[[str], None] | None = None,
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
        ok, raw = await _run_streaming(cmd, timeout_s, on_progress_line)
        result.throughput_raw = raw
        if not ok:
            result.throughput_error = "vllm bench throughput failed (non-zero exit)"
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
