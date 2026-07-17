#!/usr/bin/env python3
"""gb10-agent — unprivileged chat/agent + tool-execution daemon for the gb10 Model Swapper.

Runs as a dedicated, sandboxed OS user (own uid; NO sudo, NOT in the docker group), jailed to its
own home directory by its systemd unit (ProtectSystem=strict + ReadWritePaths=<that home>). The
browser talks to THIS service directly for chat — so untrusted model output, and (next) fetched
web-search content, never transit the privileged swap-ui control plane. This daemon only ever
reaches the loaded model on localhost:8002 and the public internet.

Deliberately kept off the privileged path:
  · no docker / nvidia-smi / apt / sudo — those stay in gb10-swap.service.
  · reads only the model endpoint on :8002 and (soon) does outbound HTTP for web search.

Endpoints:
  GET  /health          liveness + identity (proves the jail: reports uid/home) + model status
  POST /api/chat        streaming chat with the loaded model. The agent tool loop lands here.

Tailnet-only, no plaintext HTTP on the wire: the daemon binds 127.0.0.1:8090 (never a routable
interface), and the ONLY way in is `tailscale serve` terminating TLS on the tailnet and forwarding
to loopback — path mount /agent → 127.0.0.1:8090. The browser calls same-origin
https://<node>.ts.net/agent/... (no CORS). Author on your dev machine, deploy into the sandboxed
user's home directory. See README.md.
"""
from __future__ import annotations

import argparse
import json
import os
import pwd
import time
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from starlette.types import ASGIApp, Receive, Scope, Send

SERVE_PORT = int(os.environ.get("SERVE_PORT", "8002"))
MODEL_BASE = f"http://localhost:{SERVE_PORT}"
# When fronted by `tailscale serve --set-path /agent`, the daemon may receive the mount prefix on the
# path. If so, set STRIP_PREFIX=/agent and this middleware removes it before routing. Empty = no-op
# (LAN-direct and prefix-stripping proxies both work with the default).
STRIP_PREFIX = os.environ.get("STRIP_PREFIX", "").rstrip("/")

# Pooled client for talking to the local model (read=None: generation can take minutes).
_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    global _client
    _client = httpx.AsyncClient(timeout=httpx.Timeout(connect=10, read=None, write=60, pool=None))
    yield
    await _client.aclose()


class _StripPrefix:
    """Strip a fixed path prefix (e.g. /agent) added by an upstream path-mount proxy."""

    def __init__(self, app: ASGIApp, prefix: str) -> None:
        self.app = app
        self.prefix = prefix

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if self.prefix and scope["type"] == "http":
            path = scope.get("path", "")
            if path == self.prefix or path.startswith(self.prefix + "/"):
                scope = dict(scope)
                scope["path"] = path[len(self.prefix):] or "/"
        await self.app(scope, receive, send)


app = FastAPI(title="gb10-agent", lifespan=_lifespan)
if STRIP_PREFIX:
    app.add_middleware(_StripPrefix, prefix=STRIP_PREFIX)
# No CORS: the browser reaches this daemon same-origin, through the tailnet HTTPS path mount
# (https://<node>.ts.net/agent/...). There is no cross-origin call to permit.


async def _current_model() -> dict[str, Any]:
    """What vLLM reports on :8002 — served-model name + health. None/False when nothing's loaded."""
    assert _client is not None
    served = None
    healthy = False
    try:
        r = await _client.get(f"{MODEL_BASE}/v1/models", timeout=3)
        if r.status_code == 200:
            items = (r.json() or {}).get("data") or []
            if items:
                served = items[0].get("id")
        h = await _client.get(f"{MODEL_BASE}/health", timeout=3)
        healthy = h.status_code == 200
    except httpx.HTTPError:
        pass
    return {"served_name": served, "healthy": bool(healthy and served)}


@app.get("/health")
async def health() -> dict[str, Any]:
    """Liveness + identity. The uid/home fields prove the daemon runs jailed as its own sandboxed
    user, not the privileged swap-ui account."""
    u = pwd.getpwuid(os.getuid())
    return {
        "status": "ok",
        "user": u.pw_name,
        "uid": os.getuid(),
        "home": u.pw_dir,
        "model": await _current_model(),
        "ts": int(time.time()),
    }


def _sse(obj: Any) -> bytes:
    # obj == "[DONE]" -> the SSE sentinel; otherwise a JSON event the browser parses.
    return (f"data: {obj}\n\n" if obj == "[DONE]" else f"data: {json.dumps(obj)}\n\n").encode()


# These models are reasoning models: the chain-of-thought is emitted into the token budget before the
# final answer. A cap too low starves the model mid-thought — it hits finish_reason=length having
# emitted only reasoning, so no answer arrives. Give reasoning ample room; short replies still finish
# early via finish_reason=stop.
MAX_TOKENS = int(os.environ.get("MAX_TOKENS", "6144"))


@app.post("/api/chat")
async def api_chat(body: dict[str, Any]) -> StreamingResponse:
    """Streaming chat with the loaded model. Content + reasoning are relayed to the browser in
    OpenAI-SSE shape. (Formerly ran a Home Assistant tool loop; HA was removed 2026-07-12 — this is
    now a plain chat daemon, ready to be re-extended with tools later.)"""
    cur = await _current_model()
    if not cur["healthy"] or not cur["served_name"]:
        raise HTTPException(400, "no healthy model is loaded")
    history = (body or {}).get("messages") or []
    if not isinstance(history, list) or not history:
        raise HTTPException(400, "messages required")
    model = cur["served_name"]
    temperature = float((body or {}).get("temperature", 0.6))

    async def relay():
        assert _client is not None
        messages = [{"role": m["role"], "content": m.get("content", "")}
                    for m in history if m.get("role") in ("user", "assistant")]
        payload: dict[str, Any] = {"model": model, "messages": messages, "stream": True,
                                   "max_tokens": MAX_TOKENS, "temperature": temperature}

        content = ""
        finish_reason: str | None = None
        try:
            async with _client.stream("POST", f"{MODEL_BASE}/v1/chat/completions", json=payload) as r:
                if r.status_code != 200:
                    await r.aread()
                    yield _sse({"error": f"model returned {r.status_code}"})
                    return
                async for line in r.aiter_lines():
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        j = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if j.get("error"):
                        yield _sse({"error": str(j["error"])[:200]})
                        return
                    ch0 = (j.get("choices") or [{}])[0]
                    if ch0.get("finish_reason"):
                        finish_reason = ch0["finish_reason"]
                    delta = ch0.get("delta") or {}
                    if delta.get("content"):
                        content += delta["content"]
                        yield _sse({"choices": [{"delta": {"content": delta["content"]}}]})
                    rs = delta.get("reasoning") or delta.get("reasoning_content")
                    if rs:
                        yield _sse({"choices": [{"delta": {"reasoning": rs}}]})
        except Exception as exc:  # noqa: BLE001
            yield _sse({"error": str(exc)[:200]})
            return

        # If the model hit the token cap mid-reasoning with nothing to show, don't end silently.
        if finish_reason == "length" and not content:
            yield _sse({"error": "The model ran out of room while thinking and didn't finish. "
                                 "Try again, or state the request more specifically."})
        yield _sse("[DONE]")

    return StreamingResponse(
        relay(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="gb10-agent daemon")
    # Bind loopback only — reachable exclusively via the tailnet HTTPS path mount, never the LAN.
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8090")))
    args = ap.parse_args()
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
