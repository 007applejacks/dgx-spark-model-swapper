#!/usr/bin/env python3
"""gb10 Model Swapper — FastAPI control plane for a DGX Spark's one-model-at-a-time vLLM serving.

Runs ON the box (so it drives local docker/nvidia-smi with no SSH hop) and exposes a small REST
API plus the built React dashboard. The heavy lifting — the actual stop→drain→serve swap with its
validated per-model recipe — is delegated to the sibling bash drivers
(../orchestration/gb10-swap.sh, which wraps gb10-serve.sh/gb10-stop.sh/gb10-lib.sh), the single
source of truth for the delicate vLLM flags. This layer only observes state and kicks off swaps.

See swap-ui/README.md for deploy/operate notes.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as _dt
import json
import os
import re
import shutil
import subprocess
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

import benchmarks

# --- Paths & config -------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent            # .../swap-ui
ORCH_DIR = SCRIPT_DIR.parent / "orchestration"
DIST_DIR = SCRIPT_DIR / "frontend" / "dist"
SWAP_SH = ORCH_DIR / "gb10-swap.sh"

# Model recipes live in the dedicated gb10-model-configs repo — the box is the system of record
# for it, so the swap-ui reads recipes there and Promote commits+pushes from the box. Falls back
# to the in-tree models/ dir for local dev (Mac), where the configs clone doesn't exist.
CONFIGS_REPO = Path(os.environ.get("CONFIGS_REPO", "/home/deploy/github/gb10-model-configs"))
MODELS_DIR = (CONFIGS_REPO / "models") if (CONFIGS_REPO / "models").is_dir() else (SCRIPT_DIR.parent / "models")

SERVE_PORT = int(os.environ.get("SERVE_PORT", "8002"))
HF_CACHE_VOL = os.environ.get("HF_CACHE_VOL", "tokenai-hf-cache")
VLLM_IMAGE = os.environ.get("VLLM_IMAGE", "vllm/vllm-openai:v0.24.0-aarch64")
DRAIN_TIMEOUT = os.environ.get("DRAIN_TIMEOUT", "180")
# HF token for authenticated / gated / full-speed downloads. Comes from the systemd unit's
# EnvironmentFile=-/etc/gb10-swap.env (root-owned, never committed). Empty → unauthenticated pulls.
HF_TOKEN = os.environ.get("HF_TOKEN", "")

# A valid HF repo id is "<owner>/<name>"; validate before it reaches docker/curl (injection guard).
_REPO_RE = re.compile(r"^[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*$")
# A registry id is a filesystem-safe slug we control.
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")

# A single global swap job (only one swap can run — the GPU holds one model anyway).
JOB: dict[str, Any] = {
    "id": 0,
    "model_id": None,
    "phase": None,          # stopping | draining | starting | waiting-health
    "state": "idle",        # idle | running | done | error
    "result": None,         # SWAPPED <name> | NOOP <name> | WEDGED | ERROR <msg>
    "progress": None,       # latest tqdm-style line from wait_health (first-boot download/load), if any
    "log": [],              # tail of driver stdout
    "started_at": None,
    "finished_at": None,
}
_job_lock = asyncio.Lock()

# A single global download job (weights pull is disk/network, independent of the GPU — so it may
# run while a model is serving; only one download at a time to keep it legible).
DL: dict[str, Any] = {
    "id": 0,
    "repo": None,
    "state": "idle",        # idle | running | done | error
    "progress": None,        # last tqdm-ish progress line
    "result": None,          # OK <repo> | ERROR <msg>
    "log": [],
    "started_at": None,
    "finished_at": None,
}
_dl_lock = asyncio.Lock()

# A single global test run (stability battery against the loaded model).
TEST: dict[str, Any] = {
    "id": 0, "model_id": None, "served_name": None, "state": "idle",
    "tests": [], "report": {}, "experimental_cleared": False,
    "started_at": None, "finished_at": None,
}
_test_lock = asyncio.Lock()

# A single global offline-throughput-benchmark run. Disruptive by design (unload -> benchmark a
# throwaway standalone instance -> reload) — the /api/benchmark/throughput endpoint requires the
# frontend to have shown an explicit "this takes the model offline" warning before calling it; see
# benchmarks.py's module docstring for why this can't just hit the already-running server.
THROUGHPUT: dict[str, Any] = {
    "id": 0, "model_id": None, "served_name": None, "state": "idle",
    "phase": None,          # stopping | draining | benchmarking | reloading
    "result": {}, "reload_ok": None,
    "started_at": None, "finished_at": None,
}
_throughput_lock = asyncio.Lock()

# In-memory availability cache (which registry models have downloaded weights). Refreshed on
# demand via POST /api/models/refresh and once at startup.
_availability: dict[str, bool] = {}

# Pooled client for the transparent model proxy (read=None: generation can take minutes).
_proxy_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    global _availability, _proxy_client
    _proxy_client = httpx.AsyncClient(timeout=httpx.Timeout(connect=10, read=None, write=60, pool=None))
    _availability = _scan_availability()      # initial weight-availability scan
    yield
    await _proxy_client.aclose()


app = FastAPI(title="gb10 Model Swapper", lifespan=_lifespan)


# --- small subprocess helpers ---------------------------------------------------------------
def _run(cmd: list[str], timeout: float = 15.0) -> tuple[int, str, str]:
    """Run a local command, return (rc, stdout, stderr). Never raises on non-zero exit."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except FileNotFoundError:
        return 127, "", f"not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s: {' '.join(cmd)}"


def _curl_json(url: str, timeout: float = 4.0) -> Any | None:
    rc, out, _ = _run(["curl", "-fsS", "--max-time", str(int(timeout)), url], timeout=timeout + 2)
    if rc != 0 or not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


# --- model registry -------------------------------------------------------------------------
_KV_RE = re.compile(r'^([A-Z_][A-Z0-9_]*)=(.*)$')


def _parse_env_file(path: Path) -> dict[str, str]:
    """Parse a models/*.env file (plain KEY="value" lines) — no shell evaluation."""
    out: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = _KV_RE.match(line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if len(val) >= 2 and val[0] in "\"'" and val[-1] == val[0]:
            val = val[1:-1]
        out[key] = val
    return out


def _hf_cache_dirname(repo: str) -> str:
    """HF hub cache dir name for a repo id, e.g. nvidia/Foo -> models--nvidia--Foo."""
    return "models--" + repo.replace("/", "--")


def _env_path_for(model_id: str) -> Path | None:
    p = MODELS_DIR / f"{model_id}.env"
    return p if p.is_file() else None


def _git_status() -> dict[str, str]:
    """Map recipe filename -> git state within the configs repo: 'draft' (untracked/modified) vs
    absent (=committed/clean). gb10 is the system of record, so committed = official."""
    if not (CONFIGS_REPO / ".git").is_dir():
        return {}
    rc, out, _ = _run(["git", "-C", str(CONFIGS_REPO), "status", "--porcelain", "--", "models"], timeout=8.0)
    if rc != 0:
        return {}
    dirty: dict[str, str] = {}
    for line in out.splitlines():
        # porcelain: 'XY <path>' ; untracked '?? models/x.env', modified ' M models/x.env'
        path = line[3:].strip().strip('"')
        name = Path(path).name
        if name.endswith(".env"):
            dirty[name] = "draft"
    return dirty


def _load_registry() -> list[dict[str, Any]]:
    dirty = _git_status()
    models: list[dict[str, Any]] = []
    for env_path in sorted(MODELS_DIR.glob("*.env")):
        e = _parse_env_file(env_path)
        served = e.get("SERVED_NAME") or env_path.stem
        repo = e.get("SERVE_MODEL", "")
        model_id = env_path.stem
        models.append({
            "id": model_id,
            "served_name": served,
            "container": e.get("SERVE_CONTAINER", f"swap-vllm-{model_id}"),
            "repo": repo,
            "cache_dir": _hf_cache_dirname(repo) if "/" in repo else "",
            "label": e.get("UI_LABEL", served),
            "desc": e.get("UI_DESC", ""),
            "size": e.get("UI_SIZE", ""),          # memory · type · context (e.g. "~19 GB · A3B MoE · 128K ctx")
            "speed": e.get("UI_SPEED", ""),        # decode throughput, e.g. "~62 tok/s"
            "use_cases": [u.strip() for u in e.get("UI_USE_CASES", "").split(",") if u.strip()],
            "experimental": e.get("EXPERIMENTAL", "0") == "1",
            # committed (official, in the configs repo) vs draft (uncommitted/edited on gb10)
            "source": dirty.get(env_path.name, "committed"),
            "downloaded": _availability.get(model_id, False),
        })
    return models


def _scan_availability() -> dict[str, bool]:
    """List the HF-cache volume's hub/ dir once and mark which registry repos are downloaded."""
    rc, out, _ = _run(
        ["docker", "run", "--rm", "--entrypoint", "ls", "-v", f"{HF_CACHE_VOL}:/hf", VLLM_IMAGE, "/hf/hub"],
        timeout=30.0,
    )
    present = set(out.split()) if rc == 0 else set()
    avail: dict[str, bool] = {}
    for env_path in sorted(MODELS_DIR.glob("*.env")):
        e = _parse_env_file(env_path)
        repo = e.get("SERVE_MODEL", "")
        # If we couldn't read the cache at all (rc!=0), fall back to "unknown"->False rather than lying.
        avail[env_path.stem] = _hf_cache_dirname(repo) in present if repo else False
    return avail


# --- GPU + current-model observation --------------------------------------------------------
def _int(x: str) -> int | None:
    try:
        return int(float(x))
    except (ValueError, TypeError):
        return None


def _mem_from_os() -> tuple[int | None, int | None]:
    """Unified-memory usage from the OS. The GB10 shares system RAM as its GPU memory, so
    nvidia-smi reports GPU mem as N/A — /proc/meminfo is the honest 'how full is the bay' signal
    (a loaded model dominates it). used = MemTotal - MemAvailable (excludes reclaimable cache)."""
    try:
        info: dict[str, int] = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            k, _, v = line.partition(":")
            info[k.strip()] = int(v.strip().split()[0])  # kB
        total = info.get("MemTotal", 0) // 1024
        avail = info.get("MemAvailable", 0) // 1024
        return (total - avail, total) if total else (None, None)
    except (OSError, ValueError):
        return (None, None)


def _gpu_state() -> dict[str, Any]:
    # Query only fields the GB10 actually reports (name/util/temp). GPU memory is N/A on unified
    # memory, so it comes from the OS instead. A failed query / ERR! name == wedged.
    rc, out, err = _run([
        "nvidia-smi",
        "--query-gpu=name,utilization.gpu,temperature.gpu",
        "--format=csv,noheader,nounits",
    ])
    if rc != 0 or not out:
        return {"ok": False, "wedged": True, "detail": err or "nvidia-smi failed"}
    parts = [p.strip() for p in out.splitlines()[0].split(",")]
    name = parts[0] if parts else ""
    if "ERR" in name.upper():
        return {"ok": False, "wedged": True, "detail": "GPU reports ERR!"}
    mem_used, mem_total = _mem_from_os()
    return {
        "ok": True, "wedged": False, "name": name,
        "mem_used_mb": mem_used, "mem_total_mb": mem_total,
        "mem_pct": round(100 * mem_used / mem_total) if (mem_used and mem_total) else 0,
        "util_pct": _int(parts[1]) if len(parts) > 1 else None,
        "temp_c": _int(parts[2]) if len(parts) > 2 else None,
    }


def _running_serve_container() -> str | None:
    rc, out, _ = _run(["docker", "ps", "--format", "{{.Names}} {{.Ports}}"])
    if rc != 0:
        return None
    port_tag = f":{SERVE_PORT}->"
    for line in out.splitlines():
        name = line.split(" ", 1)[0]
        if name.startswith("swap-vllm-") or port_tag in line:
            return name
    return None


def _metric_sum(lines: list[str], name: str) -> float | None:
    """Sum all Prometheus series for an exact metric name (name{...} value). Exact match on the '{'
    (or a space) so e.g. num_requests_waiting doesn't also match num_requests_waiting_by_reason."""
    total = None
    for line in lines:
        if line.startswith(name + "{") or line.startswith(name + " "):
            try:
                total = (total or 0.0) + float(line.rsplit(" ", 1)[1])
            except (ValueError, IndexError):
                pass
    return total


# Previous generation-tokens sample for computing a live rate across status polls.
_prev_gen: dict[str, float | None] = {"t": None, "tokens": None}


def _serve_stats() -> dict[str, Any] | None:
    """Connections + live throughput + activity totals from vLLM's Prometheus metrics (one scrape).
    None when nothing's loaded / metrics aren't exposed."""
    rc, out, _ = _run(["curl", "-fsS", "--max-time", "3", f"http://localhost:{SERVE_PORT}/metrics"])
    if rc != 0 or not out:
        return None
    lines = [ln for ln in out.splitlines() if not ln.startswith("#")]
    running = _metric_sum(lines, "vllm:num_requests_running")
    waiting = _metric_sum(lines, "vllm:num_requests_waiting")
    gen = _metric_sum(lines, "vllm:generation_tokens_total")
    prompt = _metric_sum(lines, "vllm:prompt_tokens_total")
    reqs = _metric_sum(lines, "vllm:request_generation_tokens_count")
    if running is None and gen is None:
        return None

    # live decode throughput = Δ generation tokens / Δ time since the last poll
    now = time.monotonic()
    rate: float | None = None
    prev_t, prev_tok = _prev_gen["t"], _prev_gen["tokens"]
    if gen is not None and prev_t is not None and prev_tok is not None and gen >= prev_tok:
        dt = now - prev_t
        if dt >= 0.5:
            rate = round((gen - prev_tok) / dt, 1)
    if gen is not None:
        _prev_gen["t"], _prev_gen["tokens"] = now, gen

    return {
        "connections": {"running": int(running or 0), "waiting": int(waiting or 0)},
        "throughput": {
            "gen_tok_s": rate,
            "total_gen_tokens": int(gen or 0),
            "total_prompt_tokens": int(prompt or 0),
            "total_requests": int(reqs or 0),
        },
    }


def _container_uptime_s(container: str) -> int | None:
    """Seconds since the serve container started (how long the current model has been up)."""
    rc, out, _ = _run(["docker", "inspect", "-f", "{{.State.StartedAt}}", container])
    if rc != 0 or not out:
        return None
    s = out.strip()
    try:
        if "." in s:  # RFC3339Nano -> trim fractional to microseconds
            head, frac = s.split(".", 1)
            iso = f"{head}.{frac.rstrip('Z')[:6]}+00:00"
        else:
            iso = s.replace("Z", "+00:00")
        started = _dt.datetime.fromisoformat(iso)
        return max(0, int((_dt.datetime.now(_dt.timezone.utc) - started).total_seconds()))
    except (ValueError, TypeError):
        return None


def _current_model() -> dict[str, Any]:
    """Authoritative current model: what vLLM reports on :8002, cross-referenced to the registry."""
    container = _running_serve_container()
    health = _run(["curl", "-fsS", "--max-time", "3", f"http://localhost:{SERVE_PORT}/health"])[0] == 0
    served = None
    data = _curl_json(f"http://localhost:{SERVE_PORT}/v1/models")
    if isinstance(data, dict):
        items = data.get("data") or []
        if items:
            served = items[0].get("id")
    model_id = None
    for m in _load_registry():
        if served and m["served_name"] == served:
            model_id = m["id"]
            break
    return {
        "container": container,
        "served_name": served,
        "model_id": model_id,
        "healthy": bool(health and served),
        "loaded": container is not None,
        "uptime_s": _container_uptime_s(container) if container else None,
    }


# --- API routes -----------------------------------------------------------------------------
@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/logs")
def api_logs(source: str = "model", lines: int = 300) -> dict[str, Any]:
    """Tail an important log: the loaded model's vLLM container, or the swap-ui service journal."""
    n = max(20, min(int(lines), 1500))
    if source == "model":
        cur = _current_model()
        if not cur["container"]:
            return {"source": source, "label": "vLLM model", "text": "(no model loaded)"}
        _rc, out, err = _run(["docker", "logs", "--tail", str(n), cur["container"]], timeout=15.0)
        text = "\n".join(p for p in (err, out) if p) or "(no output)"   # vLLM logs to stderr
        return {"source": source, "label": f"vLLM · {cur['container']}", "text": text[-60000:]}
    if source == "service":
        _rc, out, err = _run(
            ["journalctl", "-u", "gb10-swap", "-n", str(n), "--no-pager", "-o", "short-iso"], timeout=15.0)
        return {"source": source, "label": "swap-ui service",
                "text": (out or err or "(journal not readable)")[-60000:]}
    raise HTTPException(400, "unknown log source")


@app.get("/api/status")
def api_status() -> dict[str, Any]:
    stats = _serve_stats()
    return {
        "current": _current_model(),
        "gpu": _gpu_state(),
        "connections": stats["connections"] if stats else None,
        "throughput": stats["throughput"] if stats else None,
        "swap": _job_public(),
        "serve_port": SERVE_PORT,
        "ts": int(time.time()),
    }


def _ups_status() -> dict[str, Any]:
    """APC UPS telemetry via apcaccess (apcupsd reads the USB-connected Back-UPS). Read-only;
    parsed into the fields the dashboard card shows. available=False when there's no UPS/daemon."""
    rc, out, err = _run(["apcaccess", "status"], timeout=8)
    if rc != 0 or not out:
        return {"available": False, "detail": (err or out or "apcaccess unavailable")[:200]}
    d: dict[str, str] = {}
    for line in out.splitlines():
        k, sep, v = line.partition(":")
        if sep:
            d[k.strip()] = v.strip()

    def num(key: str) -> float | None:
        try:
            return float(d[key].split()[0])
        except (KeyError, ValueError, IndexError):
            return None

    status = (d.get("STATUS") or "").strip()
    load_pct, nom_w = num("LOADPCT"), num("NOMPOWER")
    return {
        "available": True,
        "model": d.get("MODEL"),
        "status": status,
        "online": status.upper().startswith("ONLINE"),
        "on_battery": "ONBATT" in status.upper(),
        "charge_pct": num("BCHARGE"),
        "load_pct": load_pct,
        "watts": round(nom_w * load_pct / 100) if (nom_w is not None and load_pct is not None) else None,
        "nom_power_w": nom_w,
        "timeleft_min": num("TIMELEFT"),
        "line_v": num("LINEV"),
        "batt_v": num("BATTV"),
        "temp_c": num("ITEMP"),
        "time_on_batt_s": num("TONBATT"),
        "last_xfer": d.get("LASTXFER"),
    }


@app.get("/api/ups")
def api_ups() -> dict[str, Any]:
    return _ups_status()


@app.get("/api/models")
def api_models() -> dict[str, Any]:
    return {"models": _load_registry(), "current": _current_model()}


@app.post("/api/models/refresh")
def api_refresh() -> dict[str, Any]:
    global _availability
    _availability = _scan_availability()
    return {"models": _load_registry()}


@app.post("/api/swap")
async def api_swap(body: dict[str, Any]) -> dict[str, Any]:
    model_id = (body or {}).get("model_id")
    if not model_id:
        raise HTTPException(400, "model_id required")
    env_path = _env_path_for(model_id)
    if env_path is None:
        raise HTTPException(404, f"unknown model: {model_id}")
    if THROUGHPUT["state"] == "running":
        raise HTTPException(409, "an offline throughput benchmark is unloading/reloading the model — try again once it finishes")
    async with _job_lock:
        if JOB["state"] == "running":
            raise HTTPException(409, f"a swap to {JOB['model_id']} is already in progress")
        _job_reset(model_id)
    asyncio.create_task(_run_swap(model_id, env_path))
    return {"accepted": True, "job": _job_public()}


@app.get("/api/swap/status")
def api_swap_status() -> dict[str, Any]:
    return _job_public()


# NOTE: chat moved off this privileged (sudo+docker) service. It now runs on the unprivileged
# gb10-agent daemon (its own sandboxed OS user, jailed to its own home — see
# systemd/gb10-agent.service), reached same-origin via the tailnet path mount /agent →
# 127.0.0.1:8090. Untrusted model output / web-search content must never transit this process.


@app.post("/api/unload")
def api_unload() -> dict[str, Any]:
    """Stop the serving vLLM container(s) and leave the GB10 free (empty bay). Same stop criteria as
    a swap (serving containers only — a portless model download is left running). Also clears the
    last-model state so a reboot comes up empty rather than reloading."""
    rc, out, _ = _run(["docker", "ps", "--format", "{{.Names}}\t{{.Ports}}\t{{.Image}}"])
    stopped: list[str] = []
    if rc == 0:
        port_tag = f":{SERVE_PORT}->"
        for line in out.splitlines():
            parts = line.split("\t")
            name = parts[0]
            ports = parts[1] if len(parts) > 1 else ""
            image = parts[2] if len(parts) > 2 else ""
            if name.startswith("swap-vllm-") or port_tag in ports or ("vllm" in image and ports):
                _run(["docker", "stop", "-t", "10", name], timeout=40.0)
                stopped.append(name)
    # Clear the boot-restore marker so gb10-serve-boot.service doesn't reload it after a reboot.
    state = Path(os.environ.get("GB10_SWAP_STATE_DIR", str(Path.home() / ".config/gb10-swap"))) / "last-model"
    try:
        if state.exists():
            state.write_text("")
    except OSError:
        pass
    return {"unloaded": stopped}


# --- disk / weights management ----------------------------------------------------------------
def _protected_cache_dirs() -> set[str]:
    """Cache dirs currently being WRITTEN TO by an in-flight swap or explicit download — must never
    be touched by the disk cleanup/delete endpoints. A swap's target weights download as part of
    `docker run` (gb10-serve.sh), invisible to DL; an explicit Import download is tracked in DL.
    Missing this guard lets the 'aborted-download leftovers' Clean button delete a live
    .incomplete shard mid-download, orphaning the huggingface_hub lock and wedging the pull
    forever (no error, no progress, stuck)."""
    protected: set[str] = set()
    if JOB["state"] == "running" and JOB.get("model_id"):
        m = next((x for x in _load_registry() if x["id"] == JOB["model_id"]), None)
        if m and m["cache_dir"]:
            protected.add(m["cache_dir"])
    if DL["state"] == "running" and DL.get("repo"):
        protected.add(_hf_cache_dirname(DL["repo"]))
    return protected


def _disk_usage() -> dict[str, int] | None:
    rc, out, _ = _run(["df", "-B1", "--output=size,used,avail", "/"])
    if rc != 0:
        return None
    lines = out.strip().splitlines()
    if len(lines) < 2:
        return None
    try:
        size, used, avail = (int(x) for x in lines[-1].split())
    except ValueError:
        return None
    return {"total": size, "used": used, "free": avail, "pct": round(100 * used / size) if size else 0}


def _cache_usage() -> tuple[dict[str, int], int]:
    """Per-model cache dir sizes + total .incomplete bytes (EXCLUDING any cache dir currently
    protected by an in-flight swap/download — those bytes are a live download in progress, not
    'aborted-download leftovers', so they must not count toward the cleanup banner), from inside a
    container (volume is root-owned). Returns ({cache_dir: bytes}, incomplete_bytes)."""
    script = ("du -sb /hf/hub/models--* 2>/dev/null; echo ===INC===; "
              "find /hf/hub -name '*.incomplete' -printf '%s\\t%p\\n' 2>/dev/null")
    rc, out, _ = _run(
        ["docker", "run", "--rm", "-v", f"{HF_CACHE_VOL}:/hf", "--entrypoint", "sh", VLLM_IMAGE, "-c", script],
        timeout=90)
    protected = _protected_cache_dirs()
    sizes: dict[str, int] = {}
    incomplete = 0
    mode = "models"
    if rc == 0:
        for line in out.splitlines():
            if line.strip() == "===INC===":
                mode = "inc"
                continue
            if mode == "models":
                parts = line.split(None, 1)
                if len(parts) == 2:
                    try:
                        sizes[parts[1].strip().rstrip("/").split("/")[-1]] = int(parts[0])
                    except ValueError:
                        pass
            else:
                size_s, _, path = line.partition("\t")
                cache_dir = path.removeprefix("/hf/hub/").split("/")[0]
                if cache_dir in protected:
                    continue
                try:
                    incomplete += int(size_s.strip())
                except ValueError:
                    pass
    return sizes, incomplete


@app.get("/api/disk")
def api_disk() -> dict[str, Any]:
    sizes, incomplete = _cache_usage()
    cur = _current_model()
    protected = _protected_cache_dirs()
    models = []
    for m in _load_registry():
        if m["downloaded"] and m["cache_dir"]:
            models.append({"id": m["id"], "label": m["label"], "cache_dir": m["cache_dir"],
                           "bytes": sizes.get(m["cache_dir"], 0), "loaded": m["id"] == cur["model_id"],
                           "loading": m["cache_dir"] in protected})
    models.sort(key=lambda x: -x["bytes"])
    return {"fs": _disk_usage(), "cache_bytes": sum(sizes.values()),
            "incomplete_bytes": incomplete, "models": models}


@app.post("/api/disk/delete")
def api_disk_delete(body: dict[str, Any]) -> dict[str, Any]:
    model_id = (body or {}).get("model_id")
    m = next((x for x in _load_registry() if x["id"] == model_id), None)
    if not m or not m["cache_dir"]:
        raise HTTPException(404, "unknown model / no weights")
    if _current_model()["model_id"] == model_id:
        raise HTTPException(409, "model is loaded — unload it before deleting its weights")
    if m["cache_dir"] in _protected_cache_dirs():
        raise HTTPException(409, "model weights are currently downloading/loading — wait for it to finish (or cancel) before deleting")
    if not re.match(r"^models--[A-Za-z0-9._-]+$", m["cache_dir"]):  # guard the rm -rf target
        raise HTTPException(400, "unsafe cache dir")
    rc, out, err = _run(
        ["docker", "run", "--rm", "-v", f"{HF_CACHE_VOL}:/hf", "--entrypoint", "rm", VLLM_IMAGE,
         "-rf", f"/hf/hub/{m['cache_dir']}"], timeout=120)
    global _availability
    _availability = _scan_availability()
    if rc != 0:
        raise HTTPException(500, f"delete failed: {(err or out)[:200]}")
    return {"deleted": model_id}


@app.post("/api/disk/clean")
def api_disk_clean() -> dict[str, Any]:
    """Remove leftover *.incomplete blobs from aborted downloads — but never one that's actively
    downloading right now (see _protected_cache_dirs). A protected dir's cache_dir is re-validated
    against the same pattern that guards api_disk_delete's rm -rf before it's interpolated into the
    shell command below."""
    exclude = ""
    for cache_dir in sorted(_protected_cache_dirs()):
        if re.match(r"^models--[A-Za-z0-9._-]+$", cache_dir):
            exclude += f" -not -path '/hf/hub/{cache_dir}/*'"
    rc, out, err = _run(
        ["docker", "run", "--rm", "-v", f"{HF_CACHE_VOL}:/hf", "--entrypoint", "sh", VLLM_IMAGE,
         "-c", f"find /hf/hub -name '*.incomplete'{exclude} -delete"], timeout=120)
    if rc != 0:
        raise HTTPException(500, f"clean failed: {(err or out)[:200]}")
    return {"cleaned": True}


# --- system updates (apt) ---------------------------------------------------------------------
# Read-only listing needs no privilege. refresh (apt-get update) / install (apt-get upgrade) run via
# `sudo -S` with the user's password supplied per-request (piped to stdin, never logged/stored) — so
# there's NO standing passwordless grant; each privileged action is authorized by the password.
UPD: dict[str, Any] = {
    "id": 0, "action": None, "state": "idle", "result": None, "log": [],
    "started_at": None, "finished_at": None,
}
_upd_lock = asyncio.Lock()
_upd_proc: asyncio.subprocess.Process | None = None


def _upd_public() -> dict[str, Any]:
    return {k: UPD[k] for k in ("id", "action", "state", "result", "started_at", "finished_at")} | {
        "log_tail": UPD["log"][-15:]}


@app.get("/api/updates")
def api_updates() -> dict[str, Any]:
    """List upgradable packages from the cached apt lists (no sudo). Counts via apt-check if present."""
    rc, out, _ = _run(["apt", "list", "--upgradable"], timeout=25)
    packages: list[dict[str, str]] = []
    if rc == 0:
        for line in out.splitlines():
            if "/" not in line or "upgradable from" not in line:
                continue
            name = line.split("/", 1)[0]
            parts = line.split()
            newv = parts[1] if len(parts) > 1 else ""
            m = re.search(r"upgradable from:\s*([^\]]+)", line)
            packages.append({"name": name, "new": newv, "old": (m.group(1).strip() if m else "")})
    # security count (best-effort) from update-notifier's apt-check ("total;security" on stderr)
    security = None
    rc2, o2, e2 = _run(["/usr/lib/update-notifier/apt-check"], timeout=10)
    for s in (e2, o2):
        mm = re.match(r"^\s*(\d+);(\d+)", s or "")
        if mm:
            security = int(mm.group(2))
            break
    return {"count": len(packages), "security": security,
            "packages": packages[:400], "job": _upd_public()}


async def _run_apt(action: str, apt_args: list[str], password: str) -> None:
    global _upd_proc
    UPD.update({"id": UPD["id"] + 1, "action": action, "state": "running", "result": None,
                "log": [], "started_at": int(time.time()), "finished_at": None})
    # `sudo -S -p ''` reads the password from stdin silently. The password is written to stdin only —
    # never in argv, env, or the log — and sudo does not echo it.
    cmd = ["sudo", "-S", "-p", "", *apt_args]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT, env={**os.environ, "DEBIAN_FRONTEND": "noninteractive"})
        _upd_proc = proc
        assert proc.stdin is not None and proc.stdout is not None
        proc.stdin.write((password + "\n").encode())
        await proc.stdin.drain()
        proc.stdin.close()
        async for raw in proc.stdout:
            line = raw.decode(errors="replace").rstrip()
            if line:
                UPD["log"].append(line)
        await proc.wait()
        ok = proc.returncode == 0
        UPD["result"] = f"OK {action}" if ok else f"ERROR {action} failed (exit {proc.returncode} — wrong password?)"
        UPD["state"] = "done" if ok else "error"
    except Exception as exc:  # noqa: BLE001
        UPD["result"] = f"ERROR {exc}"
        UPD["state"] = "error"
    finally:
        _upd_proc = None
        UPD["finished_at"] = int(time.time())


@app.post("/api/updates/refresh")
async def api_updates_refresh(body: dict[str, Any]) -> dict[str, Any]:
    password = (body or {}).get("password") or ""
    if not password:
        raise HTTPException(400, "password required")
    async with _upd_lock:
        if UPD["state"] == "running":
            raise HTTPException(409, f"an apt {UPD['action']} is already running")
    asyncio.create_task(_run_apt("refresh", ["apt-get", "update"], password))
    return {"accepted": True, "job": _upd_public()}


@app.post("/api/updates/install")
async def api_updates_install(body: dict[str, Any]) -> dict[str, Any]:
    password = (body or {}).get("password") or ""
    if not password:
        raise HTTPException(400, "password required")
    async with _upd_lock:
        if UPD["state"] == "running":
            raise HTTPException(409, f"an apt {UPD['action']} is already running")
    # refresh metadata then upgrade, under one password — the log shows both the search and install.
    asyncio.create_task(_run_apt("install", ["sh", "-c", "apt-get update && apt-get -y upgrade"], password))
    return {"accepted": True, "job": _upd_public()}


@app.get("/api/updates/job")
def api_updates_job() -> dict[str, Any]:
    return _upd_public()


@app.post("/api/updates/cancel")
async def api_updates_cancel() -> dict[str, Any]:
    if UPD["state"] != "running":
        raise HTTPException(409, "no apt job running")
    if _upd_proc is not None:
        try:
            _upd_proc.terminate()
        except ProcessLookupError:
            pass
    return {"cancelling": True}


@app.post("/api/reboot")
async def api_reboot() -> dict[str, Any]:
    # Recover a wedged GPU. Needs passwordless sudo for /sbin/reboot (see README). Fire-and-forget;
    # this process dies with the box. We schedule it slightly delayed so the HTTP response flushes.
    if not shutil.which("sudo"):
        raise HTTPException(500, "sudo not available")
    subprocess.Popen(["bash", "-c", "sleep 1; sudo /sbin/reboot"])
    return {"rebooting": True}


# --- swap job machinery ---------------------------------------------------------------------
def _job_reset(model_id: str) -> None:
    JOB.update({
        "id": JOB["id"] + 1, "model_id": model_id, "phase": None, "state": "running",
        "result": None, "progress": None, "log": [], "started_at": int(time.time()), "finished_at": None,
    })


def _job_public() -> dict[str, Any]:
    return {k: JOB[k] for k in
            ("id", "model_id", "phase", "state", "result", "progress", "started_at", "finished_at")} | {
        "log_tail": JOB["log"][-12:]}


_swap_proc: asyncio.subprocess.Process | None = None
_swap_cancelled = False


async def _run_swap(model_id: str, env_path: Path) -> None:
    global _swap_proc, _swap_cancelled
    _swap_cancelled = False
    env = {**os.environ, "GB10_LOCAL": "1", "DRAIN_TIMEOUT": DRAIN_TIMEOUT,
           "GB10_HEALTH": f"http://localhost:{SERVE_PORT}/health"}
    try:
        # Pass the resolved recipe path (committed or draft) so both are servable.
        proc = await asyncio.create_subprocess_exec(
            "bash", str(SWAP_SH), "--env", str(env_path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=env,
        )
        _swap_proc = proc
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode(errors="replace").rstrip()
            if not line:
                continue
            JOB["log"].append(line)
            if line.startswith("PHASE "):
                JOB["phase"] = line[6:].strip()
                JOB["progress"] = None    # new phase — last phase's progress line no longer applies
            elif line.startswith("RESULT "):
                JOB["result"] = line[7:].strip()
            elif line.startswith("PROGRESS "):
                JOB["progress"] = line[9:].strip()
        await proc.wait()
        if _swap_cancelled:
            JOB["result"] = "CANCELLED"
        elif JOB["result"] is None:
            JOB["result"] = f"ERROR exit-{proc.returncode}"
        JOB["state"] = "done" if JOB["result"].split()[0] in ("SWAPPED", "NOOP") else "error"
    except Exception as exc:  # noqa: BLE001 — surface any launch failure to the UI
        JOB["result"] = f"ERROR {exc}"
        JOB["state"] = "error"
    finally:
        _swap_proc = None
        JOB["phase"] = None
        JOB["finished_at"] = int(time.time())


@app.post("/api/swap/cancel")
async def api_swap_cancel() -> dict[str, Any]:
    """Abort an in-progress load that's failing/hanging: stop the target container (which makes the
    serve's health-wait fail fast) and terminate the swap driver."""
    global _swap_cancelled
    if JOB["state"] != "running":
        raise HTTPException(409, "no swap in progress")
    _swap_cancelled = True
    target = f"swap-vllm-{JOB['model_id']}" if JOB.get("model_id") else None
    if target:
        _run(["docker", "stop", "-t", "5", target], timeout=30.0)   # frees the health-wait
    if _swap_proc is not None:
        try:
            _swap_proc.terminate()
        except ProcessLookupError:
            pass
    return {"cancelling": True}


# --- import from HuggingFace ----------------------------------------------------------------
def _slug(s: str) -> str:
    s = s.strip().lower().replace("_", "-")
    s = re.sub(r"[^a-z0-9._-]+", "-", s).strip("-.")
    return s or "model"


def _hf_config(repo: str) -> dict[str, Any] | None:
    url = f"https://huggingface.co/{repo}/resolve/main/config.json"
    # -L is required: the resolve/ endpoint 302-redirects to the CDN; without it curl returns the
    # empty redirect body and we'd never see the config.
    cmd = ["curl", "-fsSL", "--max-time", "15"]
    if HF_TOKEN:
        cmd += ["-H", f"Authorization: Bearer {HF_TOKEN}"]
    cmd.append(url)
    rc, out, _ = _run(cmd, timeout=20.0)
    if rc != 0 or not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


def _propose_recipe(repo: str, cfg: dict[str, Any] | None) -> dict[str, Any]:
    """Turn an HF repo id + its config.json into an editable, conservative serve recipe.
    Imported models default to NO spec-decode / auto KV / no sampling override (the validated
    qwen/nemotron tuning isn't inferable from config) and are flagged experimental."""
    name = repo.split("/")[-1]
    model_id = _slug(name)
    archs = (cfg or {}).get("architectures") or []
    arch = archs[0] if archs else ""
    warnings: list[str] = []

    # Reasoning parser by family (only matters for thinking models; empty => omit the flag).
    if re.search(r"nemotron", arch, re.I) or re.search(r"nemotron", name, re.I):
        parser = "nemotron_v3"
    elif re.search(r"qwen", arch, re.I) or re.search(r"qwen", name, re.I):
        parser = "qwen3"
    else:
        parser = "qwen3"
        warnings.append(f"Unknown architecture '{arch or '?'}' — defaulted reasoning parser to qwen3; verify.")

    # Context length.
    max_pos = (cfg or {}).get("max_position_embeddings")
    if isinstance(max_pos, int) and max_pos > 0:
        max_len = min(max_pos, 262144)
        if max_pos > 262144:
            warnings.append(f"Native context {max_pos} capped to 262144 to bound KV memory.")
    else:
        max_len = 131072
        warnings.append("No max_position_embeddings in config — defaulted context to 131072.")

    # Quantization.
    qc = (cfg or {}).get("quantization_config") or {}
    qmethod = str(qc.get("quant_method", "")).lower()
    blob = f"{name} {qmethod}".lower()
    if "modelopt" in qmethod or "nvfp4" in blob or "fp4" in blob:
        quant = "modelopt"
    elif "fp8" in blob:
        quant = "fp8"
    elif "awq" in qmethod:
        quant = "awq"
    else:
        quant = "auto"
        if not qc:
            warnings.append("No quantization_config — serving unquantized (auto); large models may not fit.")

    if any(k in (cfg or {}) for k in ("num_experts", "num_local_experts", "n_routed_experts")):
        warnings.append("MoE model — consider setting EXTRA_ARGS='--max-num-seqs 4' if memory is tight.")

    return {
        "id": model_id,
        "label": name,
        "desc": "Imported from HuggingFace — recipe is provisional, validate before relying on it.",
        "size": "",
        "experimental": True,
        "repo": repo,
        "served_name": model_id,
        "max_len": max_len,
        "gpu_util": "0.85",
        "quant": quant,
        "tools": True,
        "reasoning_parser": parser,
        "spec_decode": False,
        "extra_args": "",
        "warnings": warnings,
        "detected": {"architecture": arch, "max_position_embeddings": max_pos, "quant_method": qmethod or None},
    }


def _render_env(r: dict[str, Any]) -> str:
    """Render a recipe dict to a models.d/*.env file. Imported recipes pin the tuning knobs OFF
    explicitly (empty SPEC/COMPILE/KV/GENCFG) so they DON'T inherit the qwen-27b validated defaults."""
    def q(v: Any) -> str:
        return '"' + str(v).replace('"', "") + '"'

    lines = [
        "# UI-imported model recipe (host-local; gitignored). Promote via Export to version it.",
        "# Tuning knobs (spec-decode/KV/sampling) are pinned OFF — validate + tune before trusting.",
        "",
        "# --- UI metadata ---",
        f"UI_LABEL={q(r.get('label', r['id']))}",
        f"UI_DESC={q(r.get('desc', ''))}",
        f"UI_SIZE={q(r.get('size', ''))}",
        f"UI_SPEED={q(r.get('speed', ''))}",
        f"UI_USE_CASES={q(r.get('use_cases', ''))}",
        f"EXPERIMENTAL={q('1' if r.get('experimental', True) else '0')}",
        "",
        "# --- Serve recipe ---",
        f"SERVE_MODEL={q(r['repo'])}",
        f"SERVED_NAME={q(r['served_name'])}",
        f"SERVE_CONTAINER={q('swap-vllm-' + r['id'])}",
        'SERVE_PORT="8002"',
        f"MAX_LEN={q(r.get('max_len', 131072))}",
        f"GPU_UTIL={q(r.get('gpu_util', '0.85'))}",
        f"QUANT={q(r.get('quant', 'auto'))}",
        f"TOOLS={q('1' if r.get('tools', True) else '0')}",
        f"REASONING_PARSER={q(r.get('reasoning_parser', ''))}",
        f"KV_ARG={q('')}",
        f"GENCFG_ARG={q('')}",
        f"EXTRA_ARGS={q(r.get('extra_args', ''))}",
    ]
    if not r.get("spec_decode", False):
        lines += [f"SPEC_ARG={q('')}", f"COMPILE_ARG={q('')}"]
    return "\n".join(lines) + "\n"


@app.post("/api/import/inspect")
def api_import_inspect(body: dict[str, Any]) -> dict[str, Any]:
    repo = (body or {}).get("repo", "").strip()
    if not _REPO_RE.match(repo):
        raise HTTPException(400, "repo must look like 'owner/name'")
    cfg = _hf_config(repo)
    recipe = _propose_recipe(repo, cfg)
    if cfg is None:
        recipe["warnings"].insert(
            0, "Couldn't read config.json (private/gated/typo, or no HF token) — recipe is a blind default.")
    return {"repo": repo, "config_found": cfg is not None, "recipe": recipe,
            "token_present": bool(HF_TOKEN)}


@app.post("/api/models")
def api_create_model(recipe: dict[str, Any]) -> dict[str, Any]:
    model_id = _slug(str(recipe.get("id", "")))
    if not _ID_RE.match(model_id):
        raise HTTPException(400, "invalid model id")
    if not _REPO_RE.match(str(recipe.get("repo", ""))):
        raise HTTPException(400, "invalid repo id")
    if (MODELS_DIR / f"{model_id}.env").is_file():
        raise HTTPException(409, f"a model '{model_id}' already exists — pick a different id")
    recipe["id"] = model_id
    recipe.setdefault("served_name", model_id)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    (MODELS_DIR / f"{model_id}.env").write_text(_render_env(recipe))   # untracked -> draft
    global _availability
    _availability = _scan_availability()
    return {"created": model_id, "models": _load_registry()}


@app.get("/api/models/{model_id}/env")
def api_model_env(model_id: str) -> dict[str, Any]:
    p = _env_path_for(model_id)
    if p is None:
        raise HTTPException(404, "unknown model")
    e = _parse_env_file(p)
    return {"id": model_id, "path": str(p), "env": p.read_text(), "repo": e.get("SERVE_MODEL", ""),
            "source": _git_status().get(p.name, "committed")}


@app.post("/api/models/{model_id}/env")
def api_save_model_env(model_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """Hand-edit a recipe's raw .env text in place — the deliberate escape hatch for tuning knobs
    the structured Import form doesn't expose (TOOL_PARSER, KV_ARG, GENCFG_ARG, hand-authored
    header comments, ...). Writes verbatim; a committed recipe becomes a 'draft' (git-dirty) until
    re-promoted, same as any other on-disk edit — no merge/regenerate logic, so nothing about an
    existing hand-tuned recipe is ever silently rewritten."""
    p = _env_path_for(model_id)
    if p is None:
        raise HTTPException(404, "unknown model")
    text = (body or {}).get("text")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(400, "text required")
    if len(text) > 32_768:
        raise HTTPException(400, "text too large for a recipe file")
    p.write_text(text if text.endswith("\n") else text + "\n")
    global _availability
    _availability = _scan_availability()
    return {"saved": model_id, "models": _load_registry()}


@app.get("/api/models/{model_id}/hf-lookup")
def api_model_hf_lookup(model_id: str) -> dict[str, Any]:
    """Authoritative reference values for the recipe editor: re-fetch the model's OWN config.json
    from HuggingFace (never trust a guessed/remembered checkpoint config) so the user can
    hand-edit against ground truth instead of stale assumptions."""
    p = _env_path_for(model_id)
    if p is None:
        raise HTTPException(404, "unknown model")
    repo = _parse_env_file(p).get("SERVE_MODEL", "")
    if not repo or not _REPO_RE.match(repo):
        raise HTTPException(400, "this recipe has no valid SERVE_MODEL repo to look up")
    cfg = _hf_config(repo)
    if cfg is None:
        raise HTTPException(502, f"couldn't fetch config.json for {repo} (private/gated/typo, or no HF token)")
    text_cfg = cfg.get("text_config") if isinstance(cfg.get("text_config"), dict) else cfg
    moe_keys = ("num_experts", "num_local_experts", "n_routed_experts")
    moe = None
    if any(k in text_cfg for k in moe_keys):
        moe = {"num_experts": next((text_cfg[k] for k in moe_keys if k in text_cfg), None),
               "top_k_experts": text_cfg.get("top_k_experts") or text_cfg.get("num_experts_per_tok")}
    return {
        "repo": repo,
        "architecture": (cfg.get("architectures") or [None])[0],
        "max_position_embeddings": text_cfg.get("max_position_embeddings") or cfg.get("max_position_embeddings"),
        "quantization_config": cfg.get("quantization_config"),
        "dtype": cfg.get("dtype") or text_cfg.get("dtype"),
        "moe": moe,
        "total_bytes": _hf_total_bytes(repo),
    }


@app.post("/api/models/{model_id}/promote")
def api_promote_model(model_id: str) -> dict[str, Any]:
    """Commit + push a recipe to the configs repo (gb10 is the system of record). Gated: the model
    must have left experimental (i.e. passed the stability battery) and have uncommitted changes."""
    p = _env_path_for(model_id)
    if p is None:
        raise HTTPException(404, "unknown model")
    e = _parse_env_file(p)
    if e.get("EXPERIMENTAL", "0") == "1":
        raise HTTPException(409, "still experimental — pass the stability tests before promoting")
    if not (CONFIGS_REPO / ".git").is_dir():
        raise HTTPException(500, "configs repo not available on this host")
    rel = f"models/{model_id}.env"
    for args, err in (
        (["add", "--", rel], "git add failed"),
        (["commit", "-m", f"Promote {model_id} (passed stability battery)", "--", rel], "git commit failed"),
        (["push", "origin", "HEAD:main"], "git push failed"),
    ):
        rc, out, se = _run(["git", "-C", str(CONFIGS_REPO), *args], timeout=60.0)
        # 'nothing to commit' means it was already committed — treat as success, keep going to push.
        if rc != 0 and "nothing to commit" not in (out + se).lower():
            raise HTTPException(500, f"{err}: {(se or out)[:200]}")
    return {"promoted": model_id, "models": _load_registry()}


@app.delete("/api/models/{model_id}")
def api_delete_model(model_id: str, weights: bool = False) -> dict[str, Any]:
    """Remove a model's recipe from the registry. Draft → drop the file; committed → git rm + commit
    + push (gb10 is the system of record). Also removes the stopped serve container, and optionally
    purges the downloaded weights. Refuses the currently-loaded model."""
    p = _env_path_for(model_id)
    if p is None:
        raise HTTPException(404, "unknown model")
    if _current_model()["model_id"] == model_id:
        raise HTTPException(409, "model is loaded — unload it first")
    e = _parse_env_file(p)
    repo = e.get("SERVE_MODEL", "")
    cache_dir = _hf_cache_dirname(repo) if "/" in repo else ""

    if _git_status().get(p.name) == "draft":
        p.unlink()   # untracked draft: just drop the file
    else:
        rel = f"models/{model_id}.env"
        for args, errmsg in (
            (["rm", "-f", "-q", "--", rel], "git rm failed"),
            (["commit", "-m", f"Remove {model_id}", "--", rel], "git commit failed"),
            (["push", "origin", "HEAD:main"], "git push failed"),
        ):
            rc, out, se = _run(["git", "-C", str(CONFIGS_REPO), *args], timeout=60.0)
            if rc != 0 and "nothing to commit" not in (out + se).lower():
                raise HTTPException(500, f"{errmsg}: {(se or out)[:200]}")

    _run(["docker", "rm", "-f", f"swap-vllm-{model_id}"], timeout=30.0)   # drop the (stopped) container
    if weights and cache_dir and re.match(r"^models--[A-Za-z0-9._-]+$", cache_dir):
        _run(["docker", "run", "--rm", "-v", f"{HF_CACHE_VOL}:/hf", "--entrypoint", "rm", VLLM_IMAGE,
              "-rf", f"/hf/hub/{cache_dir}"], timeout=120.0)

    global _availability
    _availability = _scan_availability()
    return {"deleted": model_id, "models": _load_registry()}


@app.post("/api/import/download")
async def api_import_download(body: dict[str, Any]) -> dict[str, Any]:
    repo = (body or {}).get("repo", "").strip()
    if not _REPO_RE.match(repo):
        raise HTTPException(400, "repo must look like 'owner/name'")
    async with _dl_lock:
        if DL["state"] == "running":
            raise HTTPException(409, f"a download of {DL['repo']} is already in progress")
        DL.update({"id": DL["id"] + 1, "repo": repo, "state": "running", "progress": None,
                   "result": None, "log": [], "started_at": int(time.time()), "finished_at": None})
    asyncio.create_task(_run_download(repo))
    return {"accepted": True, "download": _dl_public()}


@app.get("/api/import/status")
def api_import_status() -> dict[str, Any]:
    return _dl_public()


def _dl_public() -> dict[str, Any]:
    return {k: DL[k] for k in
            ("id", "repo", "state", "progress", "result", "started_at", "finished_at")} | {
        "log_tail": DL["log"][-10:]}


DOWNLOAD_CONTAINER = "gb10-model-download"


def _hf_total_bytes(repo: str) -> int:
    """Total download size from the HF tree API (sum of file sizes, incl LFS). 0 if unknown."""
    url = f"https://huggingface.co/api/models/{repo}/tree/main?recursive=true"
    cmd = ["curl", "-fsSL", "--max-time", "15"]
    if HF_TOKEN:
        cmd += ["-H", f"Authorization: Bearer {HF_TOKEN}"]
    cmd.append(url)
    rc, out, _ = _run(cmd, timeout=20.0)
    if rc != 0 or not out:
        return 0
    try:
        return sum(int(f.get("size", 0)) for f in json.loads(out) if f.get("type") == "file")
    except (json.JSONDecodeError, ValueError, TypeError):
        return 0


async def _cache_dir_bytes(repo: str) -> int:
    """On-disk size of the repo's cache dir, read from INSIDE a container (the volume is root-owned,
    so the service user can't du it directly)."""
    cdir = _hf_cache_dirname(repo)
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", "run", "--rm", "-v", f"{HF_CACHE_VOL}:/hf", "--entrypoint", "du", VLLM_IMAGE,
            "-sb", f"/hf/hub/{cdir}",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await proc.communicate()
        return int(out.split()[0]) if out.split() else 0
    except (ValueError, OSError):
        return 0


_FETCH_RE = re.compile(r"Fetching\s+\d+\s+files:\s+(\d+)%\|[^|]*\|\s*(\d+)/(\d+)")


async def _download_progress(repo: str, _total: int) -> None:
    """Progress from snapshot_download's OWN file counter (M/T files, P%). This is the honest signal:
    bytes-on-disk (du) over-counts when leftover .incomplete blobs from a prior aborted pull remain,
    so a percentage from du can exceed 100%. File-count + raw GB is what the user sees; completion is
    the process exiting (which clears the spinner)."""
    while True:
        await asyncio.sleep(4)
        frac = None
        for line in reversed(DL["log"][-60:]):
            m = _FETCH_RE.search(line)
            if m:
                frac = f"{m.group(2)}/{m.group(3)} files ({m.group(1)}%)"
                break
        gb = await _cache_dir_bytes(repo) / 1e9
        DL["progress"] = f"{frac} · {gb:.1f} GB" if frac else f"{gb:.1f} GB"


async def _run_download(repo: str) -> None:
    # Pull weights into the HF cache volume via the pinned vLLM image. Xet disabled (hangs on this
    # box). HF_TOKEN (if present) lifts the rate limit + enables gated repos. Repo passed via env,
    # never interpolated into the -c code (injection-safe; also validated by _REPO_RE above).
    # Named container so it's identifiable; it publishes NO ports, so gb10-swap.sh's stop-scan skips
    # it (a swap during a download must NOT collateral-kill it — that was the exit-137 bug).
    await (await asyncio.create_subprocess_exec(
        "docker", "rm", "-f", DOWNLOAD_CONTAINER,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)).wait()
    docker_cmd = [
        "docker", "run", "--rm", "--name", DOWNLOAD_CONTAINER,
        "-e", "HF_HUB_DISABLE_XET=1",
        "-e", "PYTHONUNBUFFERED=1",
        "-e", f"HF_REPO={repo}",
    ]
    if HF_TOKEN:
        docker_cmd += ["-e", f"HF_TOKEN={HF_TOKEN}"]
    docker_cmd += [
        "-v", f"{HF_CACHE_VOL}:/root/.cache/huggingface",
        "--entrypoint", "python3", VLLM_IMAGE,
        "-c", "import os;from huggingface_hub import snapshot_download;"
              "snapshot_download(os.environ['HF_REPO']);print('DOWNLOAD_COMPLETE')",
    ]
    total = _hf_total_bytes(repo)
    poller = asyncio.create_task(_download_progress(repo, total))
    try:
        proc = await asyncio.create_subprocess_exec(
            *docker_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        assert proc.stdout is not None
        buf = b""
        while True:
            chunk = await proc.stdout.read(4096)
            if not chunk:
                break
            buf += chunk
            # Keep the raw tqdm lines in the log for diagnostics; the poller owns DL["progress"].
            parts = re.split(rb"[\r\n]", buf)
            buf = parts.pop()
            for seg in parts:
                s = seg.decode(errors="replace").strip()
                if s:
                    DL["log"].append(s)
        await proc.wait()
        global _availability
        _availability = _scan_availability()          # refresh so the new weights show as downloaded
        ok = proc.returncode == 0
        DL["result"] = f"OK {repo}" if ok else f"ERROR download exited {proc.returncode} (see log)"
        DL["state"] = "done" if ok else "error"
    except Exception as exc:  # noqa: BLE001
        DL["result"] = f"ERROR {exc}"
        DL["state"] = "error"
    finally:
        poller.cancel()
        DL["finished_at"] = int(time.time())


# --- benchmark tests (vLLM standard + lm-eval-harness) --------------------------------------
def _set_experimental(path: Path, value: str) -> None:
    """Rewrite EXPERIMENTAL=<value> in a recipe .env in place (used to clear the flag on a pass)."""
    out: list[str] = []
    found = False
    for line in path.read_text().splitlines():
        if re.match(r"^\s*EXPERIMENTAL=", line):
            out.append(f'EXPERIMENTAL="{value}"')
            found = True
        else:
            out.append(line)
    if not found:
        out.append(f'EXPERIMENTAL="{value}"')
    path.write_text("\n".join(out) + "\n")


def _test_public() -> dict[str, Any]:
    return {k: TEST[k] for k in
            ("id", "model_id", "served_name", "state", "experimental_cleared",
             "started_at", "finished_at")} | {
        "benchmark": TEST.get("benchmark", {}), "report": TEST.get("report", {})}


@app.post("/api/test")
async def api_test(_body: dict[str, Any] | None = None) -> dict[str, Any]:
    cur = _current_model()
    if not cur["loaded"] or not cur["healthy"] or not cur["served_name"]:
        raise HTTPException(400, "no healthy model is loaded — load one before testing")
    # lm-eval needs the actual HF repo (not the served name) to resolve a tokenizer — best-effort
    # fall back to served_name for an unregistered model, which won't resolve either, but there's
    # no better option without a registry entry.
    model_repo = cur["served_name"]
    if cur["model_id"]:
        p = _env_path_for(cur["model_id"])
        if p is not None:
            model_repo = _parse_env_file(p).get("SERVE_MODEL", model_repo)
    async with _test_lock:
        if TEST["state"] == "running":
            raise HTTPException(409, "a test run is already in progress")
        TEST.update({"id": TEST["id"] + 1, "model_id": cur["model_id"], "served_name": cur["served_name"],
                     "state": "running", "benchmark": {}, "report": {}, "experimental_cleared": False,
                     "started_at": int(time.time()), "finished_at": None})
    asyncio.create_task(_run_tests(cur["model_id"], cur["served_name"], model_repo))
    return {"accepted": True, "test": _test_public()}


@app.get("/api/test/status")
def api_test_status() -> dict[str, Any]:
    return _test_public()


async def _run_tests(model_id: str | None, served_name: str, model_repo: str) -> None:
    def on_update(state: dict[str, Any]) -> None:
        # state["result"] is a live BenchmarkResult dataclass, not yet JSON-safe — convert on every
        # progress tick, not just at the end, so a status poll mid-run doesn't 500 trying to encode it.
        r = state.get("result")
        TEST["benchmark"] = benchmarks.benchmark_result_to_dict(r) if r else {}
        TEST["report"] = state.get("report", {})

    try:
        result = await benchmarks.run_full_benchmark_suite(
            f"http://localhost:{SERVE_PORT}",
            served_name,
            model_id or "",
            model_repo,
            gpu_snapshot_fn=_gpu_state,
            on_progress=on_update,
        )
        TEST["benchmark"] = benchmarks.benchmark_result_to_dict(result) if result else {}
        TEST["report"] = TEST["benchmark"]
        
        # All non-error phases passed → clear the experimental flag, but ONLY if it was set
        if result and result.all_passed and model_id:
            p = _env_path_for(model_id)
            if p is not None and _parse_env_file(p).get("EXPERIMENTAL", "0") == "1":
                _set_experimental(p, "0")
                TEST["experimental_cleared"] = True
        TEST["state"] = "done"
    except Exception as exc:  # noqa: BLE001
        TEST["report"] = {"error": str(exc)}
        TEST["state"] = "error"
    finally:
        TEST["finished_at"] = int(time.time())


# --- offline throughput benchmark (disruptive — see benchmarks.py's module docstring) ----------
async def _wait_gpu_idle(timeout_s: int) -> bool:
    """Poll until no compute processes remain on the GPU — mirrors gb10_wait_gpu_idle in
    gb10-lib.sh (the same WEDGE guard gb10-swap.sh uses), so the throwaway benchmark container
    never starts before the just-stopped model has actually released its GPU memory."""
    waited = 0
    while waited < timeout_s:
        rc, out, _ = _run(["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader"])
        if rc == 0 and not out.strip():
            return True
        await asyncio.sleep(3)
        waited += 3
    return False


def _throughput_public() -> dict[str, Any]:
    return {k: THROUGHPUT[k] for k in
            ("id", "model_id", "served_name", "state", "phase", "reload_ok",
             "started_at", "finished_at")} | {"result": THROUGHPUT.get("result", {})}


@app.post("/api/benchmark/throughput")
async def api_benchmark_throughput(_body: dict[str, Any] | None = None) -> dict[str, Any]:
    """Offline throughput benchmark — DISRUPTIVE: unloads the current model, runs vLLM's own
    offline throughput benchmark (`vllm bench throughput`) against a throwaway standalone
    instance, then reloads the original model. vLLM's offline throughput benchmark has no
    remote-server backend — it always loads its own model — so this cannot run alongside the
    already-serving model without risking a double GPU allocation (OOM/wedge on this hardware).
    The frontend MUST show an explicit "this takes the model offline for several minutes"
    warning before calling this; nothing below re-confirms that."""
    cur = _current_model()
    if not cur["loaded"] or not cur["healthy"] or not cur["model_id"]:
        raise HTTPException(400, "no healthy registered model is loaded — load one before benchmarking")
    if JOB["state"] == "running":
        raise HTTPException(409, f"a swap to {JOB['model_id']} is already in progress")
    if TEST["state"] == "running":
        raise HTTPException(409, "a test run is already in progress")
    env_path = _env_path_for(cur["model_id"])
    if env_path is None:
        raise HTTPException(404, f"unknown model: {cur['model_id']}")
    model_repo = _parse_env_file(env_path).get("SERVE_MODEL")
    if not model_repo:
        raise HTTPException(400, f"recipe for {cur['model_id']} has no SERVE_MODEL")
    async with _throughput_lock:
        if THROUGHPUT["state"] == "running":
            raise HTTPException(409, "a throughput benchmark is already in progress")
        THROUGHPUT.update({
            "id": THROUGHPUT["id"] + 1, "model_id": cur["model_id"], "served_name": cur["served_name"],
            "state": "running", "phase": "stopping", "result": {}, "reload_ok": None,
            "started_at": int(time.time()), "finished_at": None,
        })
    asyncio.create_task(_run_throughput_benchmark(
        cur["model_id"], cur["served_name"], cur["container"], env_path, model_repo))
    return {"accepted": True, "throughput": _throughput_public()}


@app.get("/api/benchmark/throughput/status")
def api_benchmark_throughput_status() -> dict[str, Any]:
    return _throughput_public()


async def _run_throughput_benchmark(
    model_id: str, served_name: str, container: str | None, env_path: Path, model_repo: str,
) -> None:
    try:
        # 1. Stop whatever's currently loaded.
        THROUGHPUT["phase"] = "stopping"
        if container:
            _run(["docker", "stop", "-t", "10", container], timeout=40.0)

        # 2. Drain the GPU before the throwaway container claims it — same WEDGE guard gb10-swap.sh
        # applies on every normal swap.
        THROUGHPUT["phase"] = "draining"
        if not await _wait_gpu_idle(int(DRAIN_TIMEOUT)):
            THROUGHPUT["result"] = {"error": "GPU did not drain — likely wedged; reboot required"}
            THROUGHPUT["state"] = "error"
            return

        # 3. Run the offline throughput benchmark against a throwaway standalone instance.
        THROUGHPUT["phase"] = "benchmarking"
        result = await benchmarks.run_offline_throughput_benchmark(
            vllm_image=VLLM_IMAGE, hf_cache_vol=HF_CACHE_VOL, model_repo=model_repo,
            model_id=model_id, gpu_snapshot_fn=_gpu_state,
        )
        THROUGHPUT["result"] = benchmarks.throughput_result_to_dict(result)

        # 4. Reload the original model — same driver script as a normal swap, run regardless of
        # whether the benchmark above succeeded, so the box never sits with the model unloaded.
        THROUGHPUT["phase"] = "reloading"
        env = {**os.environ, "GB10_LOCAL": "1", "DRAIN_TIMEOUT": DRAIN_TIMEOUT,
               "GB10_HEALTH": f"http://localhost:{SERVE_PORT}/health"}
        proc = await asyncio.create_subprocess_exec(
            "bash", str(SWAP_SH), "--env", str(env_path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=env,
        )
        out_lines: list[str] = []
        assert proc.stdout is not None
        async for raw in proc.stdout:
            out_lines.append(raw.decode(errors="replace").rstrip())
        await proc.wait()
        reload_result = next(
            (l[7:].strip() for l in out_lines if l.startswith("RESULT ")),
            f"ERROR exit-{proc.returncode}",
        )
        THROUGHPUT["reload_ok"] = reload_result.split()[0] in ("SWAPPED", "NOOP")
        THROUGHPUT["state"] = "done" if (result.throughput_passed and THROUGHPUT["reload_ok"]) else "error"
        if not THROUGHPUT["reload_ok"]:
            THROUGHPUT["result"]["reload_error"] = reload_result
    except Exception as exc:  # noqa: BLE001
        THROUGHPUT["result"] = {**THROUGHPUT.get("result", {}), "error": str(exc)}
        THROUGHPUT["state"] = "error"
    finally:
        THROUGHPUT["phase"] = None
        THROUGHPUT["finished_at"] = int(time.time())


# --- transparent model proxy ------------------------------------------------------------------
# Clients hardcode a served-model-name, so they 404 when a different model is loaded. This is an
# OpenAI-compatible reverse proxy that accepts ANY model name and transparently retargets it to
# whatever is currently loaded on :8002. Point clients at http://<gb10>:8080/proxy/v1 (any model
# name works) and they never break on a swap. Streaming supported.
@app.api_route("/proxy/v1/{path:path}", methods=["GET", "POST"])
async def model_proxy(path: str, request: Request) -> Response:
    cur = _current_model()
    if not cur["served_name"] or not cur["healthy"]:
        return JSONResponse(
            {"error": {"message": "no model is loaded on gb10 — load one from the dashboard",
                       "type": "no_model_loaded", "code": "no_model_loaded"}},
            status_code=503,
        )
    url = f"http://localhost:{SERVE_PORT}/v1/{path}"
    body = await request.body()
    stream = False
    if request.method == "POST" and body:
        try:
            data = json.loads(body)
            if isinstance(data, dict):
                if "model" in data:
                    data["model"] = cur["served_name"]   # transparently retarget to the loaded model
                stream = bool(data.get("stream"))
                body = json.dumps(data).encode()
        except json.JSONDecodeError:
            pass
    fwd_headers = {"content-type": request.headers.get("content-type", "application/json")}
    params = dict(request.query_params)
    assert _proxy_client is not None

    if stream:
        async def relay():
            async with _proxy_client.stream(
                request.method, url, content=body, headers=fwd_headers, params=params
            ) as r:
                async for chunk in r.aiter_raw():
                    yield chunk
        return StreamingResponse(relay(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    r = await _proxy_client.request(request.method, url, content=body, headers=fwd_headers, params=params)
    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get("content-type", "application/json"))


# --- static SPA (mounted last so /api/* wins) -----------------------------------------------
if DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="spa")
else:
    @app.get("/")
    def _no_dist() -> JSONResponse:
        return JSONResponse(
            {"error": "frontend not built", "hint": "cd frontend && npm ci && npm run build"},
            status_code=503,
        )


def main() -> None:
    ap = argparse.ArgumentParser(description="gb10 Model Swapper backend")
    ap.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    args = ap.parse_args()
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
