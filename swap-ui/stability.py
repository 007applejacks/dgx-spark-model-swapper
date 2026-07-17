"""GB10 model-stability battery for the swap-ui.

Generic, model-agnostic checks that a served model is STABLE on the GB10 hardware — each targets a
known GB10 failure mode from the lab's own notes (silent mid-task stall, streaming hang, spec-decode
tool-call drops, OOM/wedge under load, EngineDeadError over a run, empty-output). This is NOT the
X++ coding-quality harness; it only asks "does this model serve reliably here."

Runs against the currently-loaded model on :8002. Produces per-test pass/fail plus a report of the
metrics the lab already tracks (decode tok/s, tool-call gate, finish-reason mix, reasoning length,
completion tokens, wall time) plus extras (TTFT, concurrency success, GPU mem/util/temp).
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable

import httpx

# Tunables — kept modest so the whole battery finishes in a few minutes even on the slow 120B.
# NOTE: these models are REASONING models — every request spends tokens on a <think> stream before
# any content/tool_call. Budgets must be generous or content comes back empty (all budget consumed
# by reasoning), which is model verbosity, NOT server instability. So stability tests judge "did the
# request COMPLETE cleanly" (no crash/hang/OOM); empty-output rate is reported, not failed.
TRIALS_TOOL = 6
CONCURRENCY = 4
SUSTAINED = 6
SUSTAINED_REQ_TIMEOUT = 90   # per-request stall guard inside the sustained run
LONG_TOKENS = 900   # room for a reasoning model to finish <think> AND still emit some content
LARGE_CTX_WORDS = 2600
BUDGET = 256          # generous default so reasoning can finish and still emit content

GEN_TOOL = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a location.",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {"type": "string", "description": "City name"},
                "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]},
            },
            "required": ["location"],
        },
    },
}]


def _tokps(usage: dict[str, Any] | None, dt: float) -> float | None:
    if not usage or dt <= 0:
        return None
    ct = usage.get("completion_tokens")
    return round(ct / dt, 1) if ct else None


class Runner:
    def __init__(self, base: str, model: str):
        self.base = base.rstrip("/")
        self.model = model

    async def chat(self, client: httpx.AsyncClient, messages, **kw) -> tuple[dict[str, Any], float]:
        payload = {"model": self.model, "messages": messages, **kw}
        t0 = time.monotonic()
        r = await client.post(f"{self.base}/v1/chat/completions", json=payload)
        r.raise_for_status()
        return r.json(), time.monotonic() - t0

    async def stream(self, client: httpx.AsyncClient, messages, **kw) -> tuple[int, float, float]:
        """Return (chunk_count, ttft_s, total_s). Raises on hang via the client timeout."""
        payload = {"model": self.model, "messages": messages, "stream": True, **kw}
        t0 = time.monotonic()
        ttft = 0.0
        chunks = 0
        async with client.stream("POST", f"{self.base}/v1/chat/completions", json=payload) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line.startswith("data:"):
                    continue
                if line.strip() == "data: [DONE]":
                    break
                chunks += 1
                if chunks == 1:
                    ttft = time.monotonic() - t0
        return chunks, round(ttft, 2), round(time.monotonic() - t0, 1)


def _result(name: str, title: str, target: str) -> dict[str, Any]:
    return {"name": name, "title": title, "targets": target,
            "status": "pending", "detail": "", "metrics": {}}


# Each test: (fn) -> mutate the passed result dict. Raise nothing — catch inside. Every test is
# bounded by an overall timeout so a stalled model (the silent-stall bug) can never hang the battery
# — it fails the test and moves on instead.
async def _run_one(coro: Awaitable[None], res: dict[str, Any], timeout: float = 120) -> None:
    res["status"] = "running"
    try:
        await asyncio.wait_for(coro, timeout=timeout)
    except (asyncio.TimeoutError, httpx.TimeoutException):
        res["status"] = "fail"
        res["detail"] = f"timed out (>{int(timeout)}s) — likely a silent stall / hang"
    except Exception as exc:  # noqa: BLE001
        res["status"] = "fail"
        res["detail"] = f"{type(exc).__name__}: {str(exc)[:200]}"


async def run_suite(
    base: str,
    model: str,
    gpu_snapshot: Callable[[], dict[str, Any]],
    on_update: Callable[[dict[str, Any]], None],
) -> dict[str, Any]:
    R = Runner(base, model)
    tests = [
        _result("health", "Endpoint health", "server up / model registered"),
        _result("basic", "Basic generation", "empty-output / broken serving"),
        _result("coherence", "Coherence sanity", "garbled decode / bad KV cache"),
        _result("longform", "Long-form (no stall)", "silent mid-task stall"),
        _result("streaming", "Streaming", "streaming hang"),
        _result("tools", "Tool-calling reliability", "spec-decode tool-call drops"),
        _result("largectx", "Large-context / KV", "KV-pressure OOM at long context"),
        _result("concurrency", "Concurrency", "OOM / GPU wedge under load"),
        _result("sustained", "Sustained run", "EngineDeadError over a run"),
    ]
    by = {t["name"]: t for t in tests}
    report: dict[str, Any] = {"finish_reasons": {}, "tokps_samples": [],
                              "empty_responses": 0, "total_requests": 0}
    state = {"tests": tests, "report": report}

    def bump(fr: str | None, content: str | None = None):
        report["total_requests"] += 1
        if fr:
            report["finish_reasons"][fr] = report["finish_reasons"].get(fr, 0) + 1
        if content is not None and not content.strip():
            report["empty_responses"] += 1

    limits = httpx.Timeout(connect=10, read=120, write=30, pool=120)
    async with httpx.AsyncClient(timeout=limits) as client:
        # 1. health
        async def _health():
            h = await client.get(f"{R.base}/health")
            m = await client.get(f"{R.base}/v1/models")
            names = [x["id"] for x in m.json().get("data", [])]
            ok = h.status_code == 200 and model in names
            by["health"]["status"] = "pass" if ok else "fail"
            by["health"]["detail"] = f"/health {h.status_code}; models={names}"
        await _run_one(_health(), by["health"], 25); on_update(state)
        if by["health"]["status"] != "pass":  # nothing else can pass if the endpoint is down
            for t in tests[1:]:
                t["status"] = "skip"; t["detail"] = "endpoint not healthy"
            report["gpu"] = gpu_snapshot()
            return _finalize(state)

        # 2. basic
        async def _basic():
            d, dt = await R.chat(client, [{"role": "user", "content": "Say hello in one short sentence."}],
                                 max_tokens=BUDGET, temperature=0)
            c = d["choices"][0]; content = (c["message"].get("content") or "").strip()
            bump(c.get("finish_reason"), content)
            by["basic"]["metrics"] = {"latency_s": round(dt, 1), "tok_s": _tokps(d.get("usage"), dt),
                                      "completion_tokens": d.get("usage", {}).get("completion_tokens"),
                                      "finish": c.get("finish_reason")}
            ok = bool(content)
            by["basic"]["status"] = "pass" if ok else "fail"
            by["basic"]["detail"] = (content[:80] or "EMPTY OUTPUT")
        await _run_one(_basic(), by["basic"], 90); on_update(state)

        # 3. coherence (ample budget so reasoning can finish, then it must still say the word)
        async def _coh():
            d, _ = await R.chat(client, [{"role": "user",
                "content": "Reply with exactly this single word and nothing else: STABLE"}],
                max_tokens=BUDGET, temperature=0)
            content = (d["choices"][0]["message"].get("content") or "")
            bump(d["choices"][0].get("finish_reason"), content)
            ok = "STABLE" in content.upper()
            by["coherence"]["status"] = "pass" if ok else "fail"
            by["coherence"]["detail"] = f"got: {content.strip()[:60]!r}"
        await _run_one(_coh(), by["coherence"], 90); on_update(state)

        # 4. long-form / no stall
        async def _long():
            d, dt = await R.chat(client, [{"role": "user",
                "content": "Explain in detail how a modern CPU pipeline works, covering fetch, decode, "
                           "execute, memory, and writeback stages."}],
                max_tokens=LONG_TOKENS, temperature=0.3)
            c = d["choices"][0]; m = c["message"]
            content = (m.get("content") or ""); u = d.get("usage", {})
            ct = u.get("completion_tokens") or 0
            bump(c.get("finish_reason"), content); tps = _tokps(u, dt)
            if tps:
                report["tokps_samples"].append(tps)
            by["longform"]["metrics"] = {"wall_s": round(dt, 1), "tok_s": tps,
                                         "completion_tokens": ct,
                                         "reasoning_len": len(m.get("reasoning") or m.get("reasoning_content") or ""),
                                         "finish": c.get("finish_reason")}
            # "No stall" = the model kept emitting tokens and stopped on a terminal finish reason. A
            # reasoning model can spend the whole budget on <think> and hit `length` with empty
            # content — that's verbosity (surfaced via empty_responses), NOT a silent stall. A real
            # stall is a non-terminal finish or a near-empty token stream.
            fr = c.get("finish_reason")
            ok = fr in ("stop", "length") and ct >= 50
            by["longform"]["status"] = "pass" if ok else "fail"
            if ok:
                by["longform"]["detail"] = "no stall" + (
                    "" if content.strip() else f" (reasoning-only, {ct} tok, no content before cap)")
            else:
                by["longform"]["detail"] = f"stalled: finish={fr}, {ct} tok"
        await _run_one(_long(), by["longform"], 120); on_update(state)

        # 5. streaming
        async def _stream():
            chunks, ttft, total = await R.stream(client, [{"role": "user",
                "content": "List five interesting facts about the ocean."}], max_tokens=200, temperature=0.3)
            by["streaming"]["metrics"] = {"chunks": chunks, "ttft_s": ttft, "total_s": total}
            ok = chunks >= 5
            by["streaming"]["status"] = "pass" if ok else "fail"
            by["streaming"]["detail"] = f"{chunks} chunks, TTFT {ttft}s"
        await _run_one(_stream(), by["streaming"], 90); on_update(state)

        # 6. tool-calling gate
        async def _tools():
            good = 0; details = []
            for i in range(TRIALS_TOOL):
                try:
                    d, _ = await R.chat(client, [{"role": "user",
                        "content": f"What's the weather in {'London Paris Tokyo Denver Cairo Oslo'.split()[i % 6]}? Use the tool."}],
                        tools=GEN_TOOL, tool_choice="auto", max_tokens=1600, temperature=0)
                    tc = d["choices"][0]["message"].get("tool_calls")
                    import json as _j
                    valid = bool(tc) and all(t["function"]["name"] and _j.loads(t["function"]["arguments"]) is not None for t in tc)
                    good += 1 if valid else 0
                    if not valid:
                        details.append(f"trial {i}: {str(tc)[:60]}")
                except Exception as e:  # noqa: BLE001
                    details.append(f"trial {i}: {type(e).__name__}")
            by["tools"]["metrics"] = {"gate": f"{good}/{TRIALS_TOOL}"}
            ok = good == TRIALS_TOOL
            by["tools"]["status"] = "pass" if ok else "fail"
            by["tools"]["detail"] = "all valid" if ok else "; ".join(details[:3])
        await _run_one(_tools(), by["tools"], 600); on_update(state)

        # 7. large-context / KV pressure — the server must PROCESS a long prompt without OOM/error.
        async def _largectx():
            filler = ("The quick brown fox jumps over the lazy dog. " * (LARGE_CTX_WORDS // 9))
            d, dt = await R.chat(client, [{"role": "user",
                "content": filler + "\n\nIn one sentence, what animal is mentioned above?"}],
                max_tokens=BUDGET, temperature=0)
            u = d.get("usage", {}); c = d["choices"][0]
            bump(c.get("finish_reason"), c["message"].get("content"))
            by["largectx"]["metrics"] = {"prompt_tokens": u.get("prompt_tokens"), "latency_s": round(dt, 1),
                                         "finish": c.get("finish_reason")}
            ok = c.get("finish_reason") is not None   # completed = handled the long context
            by["largectx"]["status"] = "pass" if ok else "fail"
            by["largectx"]["detail"] = f"handled {u.get('prompt_tokens')} prompt tokens"
        await _run_one(_largectx(), by["largectx"], 120); on_update(state)

        # 8. concurrency — all parallel requests must COMPLETE (server stays responsive, no wedge).
        async def _conc():
            async def one():
                d, dt = await R.chat(client, [{"role": "user", "content": "Name a primary color."}],
                                     max_tokens=96, temperature=0.5)
                return d["choices"][0], dt
            outs = await asyncio.gather(*[one() for _ in range(CONCURRENCY)], return_exceptions=True)
            done = [o for o in outs if isinstance(o, tuple)]
            for c, _ in done:
                bump(c.get("finish_reason"), c["message"].get("content"))
            by["concurrency"]["metrics"] = {"completed": f"{len(done)}/{CONCURRENCY}",
                                            "max_latency_s": round(max((o[1] for o in done), default=0), 1)}
            ok = len(done) == CONCURRENCY
            by["concurrency"]["status"] = "pass" if ok else "fail"
            errs = [str(o)[:40] for o in outs if not isinstance(o, tuple)]
            by["concurrency"]["detail"] = f"{len(done)}/{CONCURRENCY} completed" + (f"; errors: {errs[:2]}" if errs else "")
        await _run_one(_conc(), by["concurrency"], 120); on_update(state)

        # 9. sustained run — R sequential requests, no engine crash across the run. Emits progress
        # after every request so the panel visibly ticks up instead of showing a bare spinner, and
        # guards each request with its own timeout so a mid-run hang fails fast with a precise message
        # (which request stalled) rather than ambiguously running to the outer cap.
        async def _sust():
            done = 0; samples = []

            def _metrics():
                return {"completed": f"{done}/{SUSTAINED}",
                        "tok_s_min": round(min(samples), 1) if samples else None,
                        "tok_s_avg": round(sum(samples) / len(samples), 1) if samples else None}

            for _ in range(SUSTAINED):
                try:
                    d, dt = await asyncio.wait_for(
                        R.chat(client, [{"role": "user", "content": "Give me a one-line productivity tip."}],
                               max_tokens=96, temperature=0.7),
                        timeout=SUSTAINED_REQ_TIMEOUT)
                except (asyncio.TimeoutError, httpx.TimeoutException):
                    by["sustained"]["status"] = "fail"
                    by["sustained"]["metrics"] = _metrics()
                    by["sustained"]["detail"] = (
                        f"stalled on request {done + 1}/{SUSTAINED} "
                        f"(>{SUSTAINED_REQ_TIMEOUT}s, no completion) — engine may be dead")
                    return
                done += 1
                c = d["choices"][0]; bump(c.get("finish_reason"), c["message"].get("content"))
                tps = _tokps(d.get("usage"), dt)
                if tps:
                    samples.append(tps); report["tokps_samples"].append(tps)
                by["sustained"]["metrics"] = _metrics()
                by["sustained"]["detail"] = f"{done}/{SUSTAINED} completed…"
                on_update(state)  # live progress between requests
            by["sustained"]["status"] = "pass" if done == SUSTAINED else "fail"
            by["sustained"]["detail"] = f"{done}/{SUSTAINED} sequential completed"
        # outer cap = worst-case per-request budget across the whole run, plus slack
        await _run_one(_sust(), by["sustained"], SUSTAINED * SUSTAINED_REQ_TIMEOUT + 30); on_update(state)

    report["gpu"] = gpu_snapshot()
    return _finalize(state)


def _finalize(state: dict[str, Any]) -> dict[str, Any]:
    tests = state["tests"]
    report = state["report"]
    ran = [t for t in tests if t["status"] in ("pass", "fail")]
    passed = [t for t in ran if t["status"] == "pass"]
    samples = report.get("tokps_samples") or []
    report["summary"] = {
        "passed": len(passed),
        "ran": len(ran),
        "skipped": sum(1 for t in tests if t["status"] == "skip"),
        "all_passed": len(ran) > 0 and len(passed) == len(ran),
        "decode_tok_s": round(sum(samples) / len(samples), 1) if samples else None,
        "tool_gate": next((t["metrics"].get("gate") for t in tests if t["name"] == "tools"), None),
        # Reported, NOT gated: how often the reasoning model returned empty content (quality signal).
        "empty_responses": f"{report.get('empty_responses', 0)}/{report.get('total_requests', 0)}",
    }
    return state
