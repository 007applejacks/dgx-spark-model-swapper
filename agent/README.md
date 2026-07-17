# gb10-agent — sandboxed chat/agent daemon

An **unprivileged** companion to the [gb10 Model Swapper](../swap-ui/) that owns the **chat + agent
tool-execution** path. It exists so that untrusted work — model output, and (later) fetched
web-search content — never runs inside the privileged swap-ui service.

## Why a separate service + user

`gb10-swap.service` runs as **`nathan`** (in `sudo` and `docker`) because it must drive docker,
`nvidia-smi`, `apt`, and `reboot`. That is the worst identity to run agent-driven web fetches under.
So the chat/agent path is split out into this daemon, which runs as a dedicated, unprivileged user:

- own uid/group, **no `sudo`, not in `docker`**
- home directory jailed by the systemd unit (`ProtectSystem=strict`)
- reaches only the loaded model on `localhost:8002` and the public internet

| Runs as the sandboxed user (`gb10-agent`, `127.0.0.1:8090`) | Stays as `nathan` (`gb10-swap`, `:8080`) |
|---|---|
| chat + agent loop + web tools (future) | model **swap** (docker) |
| untrusted model output / web content | **status** (nvidia-smi, docker ps) |
| all outbound internet | **disk**, **apt updates**, **reboot** (sudo) |

**Naming note:** this repo's scripts and unit file still literally use `gx10` for the OS username
(`User=gx10`, home `/home/gx10`) — that's a real, already-provisioned Linux account on one specific
box, not a naming choice this repo controls. If you're setting this up fresh, use whatever username
you like and update `systemd/gb10-agent.service` + `bootstrap.sh` to match.

## Access model — tailnet-only, no plaintext HTTP on the wire

The daemon binds **loopback only** (`127.0.0.1:8090`). The sole ingress is `tailscale serve`
terminating TLS on your tailnet and forwarding to loopback via a **path mount**:

```
https://<your-box>.<your-tailnet>.ts.net/         → 127.0.0.1:8080   (gb10-swap, dashboard)
https://<your-box>.<your-tailnet>.ts.net/agent/   → 127.0.0.1:8090   (gb10-agent, chat)
```

The browser calls the daemon **same-origin** (`/agent/api/chat`), so there is no CORS and no
mixed-content, and the nathan-owned `:8080` process is not on the chat path.

### tailscale serve mount

```bash
sudo tailscale serve --bg --set-path /agent http://127.0.0.1:8090
sudo tailscale serve status        # verify /agent → 127.0.0.1:8090
```

If tailscale forwards the `/agent` prefix to the backend (rather than stripping it), set
`STRIP_PREFIX=/agent` in `/etc/gb10-agent.env` (or the unit) so the daemon routes correctly. Quick
test: `curl -s https://<your-box>.<your-tailnet>.ts.net/agent/health` — a 200 means the prefix is
stripped (leave `STRIP_PREFIX` empty); a 404 means it is forwarded (set `STRIP_PREFIX=/agent`).

## Endpoints

- `GET /health` — liveness + identity (`uid`/`home` prove the jail) + loaded-model status.
- `POST /api/chat` — streaming chat with the loaded model. Today a straight passthrough to `:8002`;
  the agent tool loop (model → tool calls → web search → continue) is built on top of this same path
  so the browser wiring never changes.

## One-time host setup (manual)

Not repo artifacts — record only. Done once, on your own box, with your own username in place of
`gx10`:

```bash
# 1. dedicated sandbox identity: no sudo, NOT in docker
sudo useradd --create-home --home-dir /home/gx10 --shell /bin/bash --user-group \
  --comment "agent tool-execution sandbox (no sudo/docker)" gx10
sudo passwd -l gx10            # lock password login
sudo chmod 750 /home/gx10

# 2. tailnet ingress (see "tailscale serve mount" above)
sudo tailscale serve --bg --set-path /agent http://127.0.0.1:8090
```

## Deploy (author here → deploy into the sandboxed user's home)

Author/commit on your dev machine, then deploy. The daemon lives under its own jail, **not** in
the nathan-owned repo clone:

```bash
# from your dev clone — stage the source, copy it into the jail, build the venv as that user
rsync -a --delete agent/ <your-box>:/tmp/gb10-agent-src/
ssh <your-box> '
  sudo -u gx10 mkdir -p /home/gx10/agent
  sudo -u gx10 cp -rT /tmp/gb10-agent-src /home/gx10/agent
  sudo -u gx10 -H bash /home/gx10/agent/bootstrap.sh
'
# install / restart the unit (from the repo systemd/ dir)
scp systemd/gb10-agent.service <your-box>:/tmp/
ssh <your-box> 'sudo cp /tmp/gb10-agent.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now gb10-agent'
```

Verify:

```bash
ssh <your-box> 'curl -s localhost:8090/health'
curl -s https://<your-box>.<your-tailnet>.ts.net/agent/health         # through the tailnet mount
```

## Files

- `agent.py` — the FastAPI daemon.
- `requirements.txt` — fastapi / uvicorn / httpx (web-search deps added when that lands).
- `bootstrap.sh` — build the venv; refuses to run as anyone but the sandboxed user.
- `run-with-secrets.sh` — ExecStart wrapper; resolves secrets from Bitwarden Secrets Manager at
  launch instead of ever writing a literal token to disk.
- `../systemd/gb10-agent.service` — hardened unit (loopback bind, home-directory jail).
