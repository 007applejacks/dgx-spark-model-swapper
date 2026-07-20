# Installer design — `install.sh`

## Purpose

`dgx-spark-model-swapper` (swap-ui + orchestration + the optional `gb10-agent` chat daemon) is
meant to be installable by other DGX Spark (GB10) owners, not just deployable to this project's
own box by hand. Today, setting it up means following two separate README runbooks by hand: build
the frontend, scp/rsync files around, create a dedicated sandboxed user for the agent, hand-write
systemd units from example placeholder values, hand-install a sudoers drop-in, etc. This design
consolidates that into one installer script.

**Audience: public.** Other DGX Spark owners are expected to actually clone this repo and run this
installer on their own hardware — not just this project's own box. That raises the bar on
correctness and clarity of failure messages, but does not require this design to auto-install
system packages or handle arbitrary non-DGX-Spark environments.

## Non-goals (explicitly out of scope for this version)

- No uninstall/rollback script.
- No auto-install of missing system prerequisites (docker, node, nvidia-container-toolkit, ...) —
  check for each and print remediation instead.
- No versioned release process (git tags / GitHub Releases / CHANGELOG). This design covers the
  installer script only.
- No handling of this project's own machine-specific migration from the legacy `ai-tools/gpu/
  gx10-compute` (`gx10-*` naming) deployment to this repo (`gb10-*` naming). That cutover is a
  separate follow-up to do by hand, using the installer once it exists — this design only makes a
  **fresh** box installable cleanly.

## Invocation

```
git clone https://github.com/007applejacks/dgx-spark-model-swapper.git
cd dgx-spark-model-swapper
./install.sh
```

Runs as the invoking (non-root) user. Shells out to `sudo` internally only for the specific
privileged steps: writing `/etc/systemd/system/*.service`, `useradd` for the agent sandbox,
writing `/etc/gb10-swap.env` / `/etc/gb10-agent.env` (root-owned, 640), `daemon-reload` /
`enable --now`. Everything else (git clone of the model-configs repo, `npm run build`,
`python3 -m venv`, docker operations) runs as the invoking user.

## Phases

1. **Prereq check** — docker present and the invoking user can run it; GPU visible to docker (a
   `nvidia-smi` + a minimal GPU-enabled `docker run` smoke test); `python3` + `venv` module;
   `node`/`npm` (only required if `swap-ui/frontend/dist/` is missing or older than
   `frontend/src/`). Any failure prints exactly what's missing and how to get it, then exits.
   Nothing in this phase is auto-installed.
2. **Config collection** — interactive prompts with sane defaults:
   - swap-ui service user (default: invoking user — NOT a new "deploy" account; `deploy` in the
     checked-in units is an example name, not a requirement)
   - install directory (default: the current repo clone path)
   - swap-ui port (default 8080), vLLM serve port (default 8002)
   - whether to install the `gb10-agent` chat daemon (default: yes)
   - if installing the agent: sandboxed user name (default `gb10-agent`), agent port (default 8090)
   - model-configs repo URL to clone (default `https://github.com/007applejacks/gb10-model-configs`,
     empty input skips this phase)
   - HF_TOKEN (optional, blank skips; only prompted if `/etc/gb10-swap.env` doesn't already exist)

   Not prompted: `manifests/containers.env`'s `GB10_SSH` placeholder. That value only feeds
   `GB10_HEALTH`, which `gb10-swap.sh`/`gb10-serve.sh` already override straight to `localhost`
   whenever `GB10_LOCAL=1` — the mode the installed systemd unit always runs in. `GB10_SSH` only
   matters for the legacy remote-driven-over-SSH path (a separate host driving this box's docker
   remotely), which is out of scope for this installer entirely. It's left at its shipped example
   value untouched.

   Answers are written to a gitignored `.install-config` file at the repo root. A re-run reads
   existing answers from this file as the shown defaults instead of starting blank — this file is
   what makes a re-run an idempotent update rather than "ask everything again."
3. **Install swap-ui**
4. **Install `gb10-agent`** (skipped if declined in step 2)
5. **Model-configs repo** (skipped if URL left empty in step 2)
6. **Verify + summary**

## Templating mechanism

The checked-in `systemd/gb10-swap.service`, `systemd/gb10-agent.service`,
`orchestration/gb10-serve-boot.service`, and `manifests/containers.env` currently use literal
example values (`User=deploy`, `/home/deploy/github/dgx-spark-model-swapper`,
`GB10_SSH=your-box-ssh-alias`) — readable as docs, but not safely machine-substitutable (matching
the literal string `deploy` is fragile: a real username could be `deploy`, or a path could contain
that substring).

**Change as part of this work:** convert the three systemd unit files to explicit `@@TOKEN@@`
placeholders (e.g. `User=@@SWAP_USER@@`, `WorkingDirectory=@@INSTALL_DIR@@/swap-ui`). `install.sh`
renders each into a real file via `sed` (no new dependency) and writes the rendered copy to
`/etc/systemd/system/`. The checked-in templates stay generic/example in git; only the render step
is new. `/etc/gb10-swap.env` and `/etc/gb10-agent.env` are generated from small in-script heredocs
rather than checked-in templates, since they're just `HF_TOKEN=...`-style files that are
root-owned and never committed anyway.

`manifests/containers.env` needs one substitution too: `OUT_DIR_HOST` (the training-output mount
path, `-v ${OUT_DIR_HOST}:/out:ro` in `gb10-serve.sh`), which defaults to `${INSTALL_DIR}/out`
(auto-derived, created if missing — no prompt needed, since there's no meaningful choice to make
here for a fresh install). Rather than editing the tracked `manifests/containers.env` in place
(which would leave the clone permanently `git status`-dirty after every install), `install.sh`
writes an untracked `manifests/containers.local.env` with just that one override, and
`gb10-lib.sh` sources it after `containers.env` when present (last-write-wins for the one
variable; every other pinned value in `containers.env` is untouched and still the single source of
truth). This is a two-line addition to `gb10-lib.sh`'s existing sourcing block.

This is the only change to files outside `install.sh` other than the `run-with-secrets.sh` fix
below — everything else the installer does is new code.

## Per-component install steps & idempotency

### swap-ui

- **venv**: run `swap-ui/bootstrap.sh` if `swap-ui/.venv/` doesn't exist; if it exists, just
  re-run `pip install -r requirements.txt` (cheap, safe to repeat) so a re-run picks up dependency
  changes without a full rebuild.
- **frontend**: `npm ci && npm run build` if `dist/` is missing or older than `frontend/src/`;
  skipped otherwise so a no-op re-run doesn't pay for a slow rebuild.
- **systemd unit**: rendered from the template every run (source of truth is the repo, not
  `/etc`). Compared against what's currently installed at `/etc/systemd/system/gb10-swap.service`;
  `daemon-reload` + `restart` only fire if the rendered content actually changed, so a re-run with
  no config changes doesn't bounce a healthy service.
- **`/etc/gb10-swap.env`**: created only if missing — never overwrites a hand-edited HF_TOKEN.
  The HF_TOKEN prompt in phase 2 is skipped entirely if this file already exists.

### `gb10-agent` (skippable)

- **dedicated user**: `useradd` only if `id <user>` fails (doesn't exist yet) — locked password,
  home dir, `chmod 750`, matching the current manual "One-time host setup" runbook.
- **copy-out deploy**: `rsync -a --delete agent/ <home>/agent/` every run (not just first install)
  — the daemon runs from a copy in its own jailed home, never from the main repo clone, so this
  re-sync is how code changes in the repo actually reach the sandbox.
- **venv**: same exists-check as swap-ui, built via `sudo -u <agent-user> -H bash bootstrap.sh`
  (that script already refuses to run as any other user).
- **`run-with-secrets.sh` fix**: today it unconditionally requires the `bws` CLI and a BWS
  access-token file at `~/.config/bws/access-token`, which would hard-fail for anyone who isn't
  this project's own author. Change it to check for that file first: if present, behave exactly as
  today (`bws run -- ...`); if absent, `exec` the daemon directly with no secrets wrapper. No
  behavior change for this project's own box; stops being a hard dependency for anyone else.
- **systemd unit**: same render-compare-restart-if-changed pattern as swap-ui.
- **tailscale serve mount**: **not automated** — printed as a manual next step in the final
  summary (exact command from the current README), since it assumes tailscale is already
  installed and logged into a tailnet, which the installer has no business assuming or
  configuring.

### model-configs repo

- Clone to the expected path only if it doesn't exist there yet. If it already exists, leave it
  completely alone — no pull, no fetch. It's the box's system of record for promoted recipes and
  may hold local draft commits the installer must not touch.

## Error handling

`set -euo pipefail`, fail-fast — matches every other script in this repo (`gb10-swap.sh`,
`gb10-serve.sh`, `gb10-lib.sh`). No transactional rollback on partial failure: if a step fails
mid-run, the user fixes the reported problem and re-runs; the idempotency rules above mean the
re-run picks up from wherever it left off rather than redoing completed steps. Each prereq/step
failure prints the specific problem and remediation (e.g. "docker not found — install it:
https://docs.docker.com/engine/install/"; "GPU not visible to docker — check
nvidia-container-toolkit is installed and the docker daemon was restarted after installing it").

## Verification

After each component starts, curl its health endpoint (`:8080/health` for swap-ui, `:8090/health`
for the agent if installed) in a short retry loop before declaring success — mirrors the existing
`wait_health` pattern in `gb10-lib.sh`, so a unit that fails to start quickly (bad venv, port
conflict) is caught immediately instead of being reported as "done" optimistically.

## Final summary output

Prints: the dashboard URL, the agent health URL (if installed), and the manual follow-ups pulled
from the current READMEs:
- tailscale serve mounts for both services
- the reboot sudoers drop-in (`/etc/sudoers.d/gb10-swap-reboot`)
- a reminder that HF_TOKEN can be added later by editing `/etc/gb10-swap.env` and restarting the
  service

## Incidental fix carried by this work

`swap-ui/README.md`'s "Notes / follow-ups" section currently documents a known limitation: "If you
change a model's `*.env` recipe, remove its stale container on the box (`docker rm
swap-vllm-<id>`) so the next swap recreates it with the new flags." This was fixed directly in
`orchestration/gb10-serve.sh` / `gb10-swap.sh` (recipe-hash container label; a changed recipe now
triggers an automatic recreate) in the same session that produced this design, prior to this
document. That README note is now stale and should be removed as part of landing this work, but is
otherwise unrelated to the installer itself.
