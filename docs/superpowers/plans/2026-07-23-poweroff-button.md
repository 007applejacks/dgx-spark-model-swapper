# Power Off Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Power off gb10" button to the dashboard's Danger Zone, as a sibling to the existing "Reboot gb10" button, that fully shuts down the physical box via `sudo /sbin/poweroff`.

**Architecture:** One new FastAPI endpoint (`POST /api/poweroff`) structurally identical to the existing `/api/reboot`, one new frontend API call, new React state + handler in `App.tsx` mirroring the existing reboot state/handler, and a second button + confirmation dialog in `DangerZone.tsx`. No new dependencies, no new gating logic, no automated test suite (matches the existing reboot flow, which also has none).

**Tech Stack:** FastAPI (Python) backend in `swap-ui/app.py`; React + TypeScript + Radix `AlertDialog` frontend in `swap-ui/frontend/src/`.

## Global Constraints

- No gating on in-flight swaps/tests/benchmarks for the poweroff endpoint or button — matches `/api/reboot`'s existing behavior exactly (spec: "Non-goals").
- No countdown/auto-reconnect UI copy — power off has no known return time, unlike reboot's "~2 min" framing (spec: "Non-goals").
- Confirmation dialog copy must stay generic about *how* the box comes back on (no mention of smart plug / BMC / WoL) — explicit direction from the design discussion.
- One sudoers line covering both `/sbin/reboot` and `/sbin/poweroff`, not two separate drop-in files (spec: "Sudoers requirement").
- `poweringOff` state, once set `true`, is never reset to `false` — matches the existing `rebooting` state's behavior (the box going down makes further tracking moot).

---

## Task 1: Backend endpoint + sudoers documentation

**Files:**
- Modify: `swap-ui/app.py:797-804` (add new endpoint after the existing `/api/reboot`)
- Modify: `swap-ui/README.md:167-182` (extend the sudoers requirement section)
- Modify: `install.sh:334-336` (extend the post-install instructions)

**Interfaces:**
- Produces: `POST /api/poweroff` → `{"poweringOff": true}` on success, `500` with `{"detail": "sudo not available"}` if `sudo` isn't on `PATH`. Later tasks (frontend) call this exact path and consume this exact response shape.

- [ ] **Step 1: Add the `/api/poweroff` endpoint**

In `swap-ui/app.py`, the existing reboot endpoint reads:

```python
@app.post("/api/reboot")
async def api_reboot() -> dict[str, Any]:
    # Recover a wedged GPU. Needs passwordless sudo for /sbin/reboot (see README). Fire-and-forget;
    # this process dies with the box. We schedule it slightly delayed so the HTTP response flushes.
    if not shutil.which("sudo"):
        raise HTTPException(500, "sudo not available")
    subprocess.Popen(["bash", "-c", "sleep 1; sudo /sbin/reboot"])
    return {"rebooting": True}
```

Immediately after it (still in `swap-ui/app.py`), add:

```python


@app.post("/api/poweroff")
async def api_poweroff() -> dict[str, Any]:
    # Fully shut gb10 down — unlike reboot, it does NOT come back on its own. Needs passwordless
    # sudo for /sbin/poweroff (see README). Fire-and-forget; this process dies with the box. We
    # schedule it slightly delayed so the HTTP response flushes.
    if not shutil.which("sudo"):
        raise HTTPException(500, "sudo not available")
    subprocess.Popen(["bash", "-c", "sleep 1; sudo /sbin/poweroff"])
    return {"poweringOff": True}
```

No new imports needed — `shutil`, `subprocess`, `HTTPException`, and `Any` are already imported and used by `api_reboot` directly above.

- [ ] **Step 2: Verify the app still imports cleanly**

Run: `cd swap-ui && python3 -c "import app"`
Expected: no output, exit code 0 (a syntax error in the new endpoint would fail this import).

- [ ] **Step 3: Manually verify the endpoint responds (safe — no sudoers grant yet, so nothing actually powers off)**

Run: `cd swap-ui && python3 -m uvicorn app:app --port 8099 &` then, in another shell:
`curl -s -X POST http://localhost:8099/api/poweroff`
Expected: `{"poweringOff":true}`
Then stop the test server: `kill %1` (or find/kill the uvicorn PID).

This confirms the endpoint returns correctly even without the sudoers grant installed — matching the documented "fails silently" behavior for `/api/reboot`, which is intentional (see Step 4's docs), not a bug to fix.

- [ ] **Step 4: Extend the sudoers documentation in `swap-ui/README.md`**

Current text (`swap-ui/README.md:167-182`):

```markdown
### Reboot button — sudoers requirement

The Reboot button runs `sudo /sbin/reboot`. Grant the service's user (`deploy` by default — see
`systemd/gb10-swap.service`) passwordless rights for just that command. Install a sudoers drop-in
on the box:

```
# /etc/sudoers.d/gb10-swap-reboot   (chmod 440, edit via visudo -f)
deploy ALL=(root) NOPASSWD: /sbin/reboot
```

**Without it, this fails silently, not loudly**: `/api/reboot` fires `sudo /sbin/reboot` in the
background and returns `{"rebooting": true}` immediately without checking whether `sudo` actually
succeeded, and the dashboard just optimistically shows "Rebooting…" — so a missing sudoers rule
means the button appears to work but the box never actually reboots, with no error surfaced
anywhere. Set this up before you need it.
```

Replace it with:

```markdown
### Reboot / power off buttons — sudoers requirement

The Reboot and Power off buttons run `sudo /sbin/reboot` and `sudo /sbin/poweroff` respectively.
Grant the service's user (`deploy` by default — see `systemd/gb10-swap.service`) passwordless
rights for just those two commands. Install a sudoers drop-in on the box:

```
# /etc/sudoers.d/gb10-swap-reboot   (chmod 440, edit via visudo -f)
deploy ALL=(root) NOPASSWD: /sbin/reboot, /sbin/poweroff
```

**Without it, this fails silently, not loudly**: `/api/reboot` and `/api/poweroff` each fire their
`sudo` command in the background and return a success response immediately without checking
whether `sudo` actually succeeded, and the dashboard just optimistically shows "Rebooting…" or
"Powering off…" — so a missing sudoers rule means the button appears to work but the box never
actually reboots or powers off, with no error surfaced anywhere. Set this up before you need it.
```

- [ ] **Step 5: Extend the post-install instructions in `install.sh`**

Current text (`install.sh:334-336`):

```bash
  echo " 2. Passwordless reboot button (needed for the dashboard's Reboot action):"
  echo "      echo '${SWAP_USER} ALL=(root) NOPASSWD: /sbin/reboot' | sudo tee /etc/sudoers.d/gb10-swap-reboot"
  echo "      sudo chmod 440 /etc/sudoers.d/gb10-swap-reboot"
```

Replace it with:

```bash
  echo " 2. Passwordless reboot/power-off buttons (needed for the dashboard's Reboot/Power off actions):"
  echo "      echo '${SWAP_USER} ALL=(root) NOPASSWD: /sbin/reboot, /sbin/poweroff' | sudo tee /etc/sudoers.d/gb10-swap-reboot"
  echo "      sudo chmod 440 /etc/sudoers.d/gb10-swap-reboot"
```

- [ ] **Step 6: Verify `install.sh` still parses**

Run: `bash -n install.sh`
Expected: no output, exit code 0.

- [ ] **Step 7: Commit**

```bash
git add swap-ui/app.py swap-ui/README.md install.sh
git commit -m "backend: add /api/poweroff endpoint + sudoers docs"
```

---

## Task 2: Frontend data/state layer

**Files:**
- Modify: `swap-ui/frontend/src/api.ts:283` (add the `poweroff` call next to `reboot`)
- Modify: `swap-ui/frontend/src/App.tsx:70` (new `poweringOff` state)
- Modify: `swap-ui/frontend/src/App.tsx:261-269` (new `onPowerOff` handler)
- Modify: `swap-ui/frontend/src/App.tsx:347` (add `poweringOff` to `busy`)
- Modify: `swap-ui/frontend/src/App.tsx:451` (pass new props to `DangerZone`)

**Interfaces:**
- Consumes: `POST /api/poweroff` from Task 1, response shape `{"poweringOff": true}`.
- Produces: `api.poweroff(): Promise<{poweringOff: boolean}>` — Task 3's `DangerZone` component receives `onPowerOff: () => void` and `poweringOff: boolean` as props (matching the existing `onReboot`/`rebooting` prop pair it already receives).

- [ ] **Step 1: Add the `poweroff` API call**

In `swap-ui/frontend/src/api.ts`, the existing line reads:

```ts
  reboot: () => fetch("/api/reboot", { method: "POST" }).then(j<{ rebooting: boolean }>),
```

Add immediately after it:

```ts
  poweroff: () => fetch("/api/poweroff", { method: "POST" }).then(j<{ poweringOff: boolean }>),
```

- [ ] **Step 2: Add `poweringOff` state**

In `swap-ui/frontend/src/App.tsx`, the existing line reads:

```ts
  const [rebooting, setRebooting] = useState(false);
```

Add immediately after it:

```ts
  const [poweringOff, setPoweringOff] = useState(false);
```

- [ ] **Step 3: Add the `onPowerOff` handler**

In `swap-ui/frontend/src/App.tsx`, the existing handler reads:

```ts
  const onReboot = useCallback(async () => {
    setRebooting(true);
    setNotice({ tone: "amber", text: "gb10 is rebooting — reconnecting in ~2 min" });
    try {
      await api.reboot();
    } catch {
      /* the box is going down; the request may not return cleanly */
    }
  }, []);
```

Add immediately after it:

```ts
  const onPowerOff = useCallback(async () => {
    setPoweringOff(true);
    setNotice({ tone: "coral", text: "gb10 is powering off — bring it back up when you're ready to reconnect" });
    try {
      await api.poweroff();
    } catch {
      /* the box is going down; the request may not return cleanly */
    }
  }, []);
```

- [ ] **Step 4: Add `poweringOff` to the `busy` computation**

The existing line reads:

```ts
  const busy = swapping || rebooting || testing || throughputBenchmarking;
```

Replace with:

```ts
  const busy = swapping || rebooting || poweringOff || testing || throughputBenchmarking;
```

- [ ] **Step 5: Pass the new props to `DangerZone`**

The existing line reads:

```tsx
        <DangerZone onReboot={onReboot} rebooting={rebooting} />
```

Replace with:

```tsx
        <DangerZone
          onReboot={onReboot}
          rebooting={rebooting}
          onPowerOff={onPowerOff}
          poweringOff={poweringOff}
        />
```

- [ ] **Step 6: Type-check the frontend**

Run: `cd swap-ui/frontend && npx tsc --noEmit`
Expected: errors referencing `DangerZoneProps` missing `onPowerOff`/`poweringOff` — this is expected until Task 3 updates `DangerZone.tsx`. Confirm the *only* errors are in `DangerZone.tsx`/`App.tsx` about these two props (no unrelated typos introduced). If `tsc` reports anything else, fix it before proceeding.

- [ ] **Step 7: Commit**

```bash
git add swap-ui/frontend/src/api.ts swap-ui/frontend/src/App.tsx
git commit -m "frontend: wire up poweroff API call and state"
```

---

## Task 3: `DangerZone` component — second button and dialog

**Files:**
- Modify: `swap-ui/frontend/src/components/DangerZone.tsx` (entire file rewritten below)

**Interfaces:**
- Consumes: `onPowerOff: () => void` and `poweringOff: boolean` props from Task 2's `App.tsx` (in addition to the existing `onReboot`/`rebooting`).

- [ ] **Step 1: Replace the full contents of `DangerZone.tsx`**

Current full file:

```tsx
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { Power, RotateCcw } from "lucide-react";
import { Button } from "./ui";

export function DangerZone({
  onReboot,
  rebooting,
}: {
  onReboot: () => void;
  rebooting: boolean;
}) {
  return (
    <section className="rounded-xl border border-coral/25 bg-coral/[0.04] px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Power className="h-5 w-5 shrink-0 text-coral" />
          <div className="min-w-0">
            <div className="eyebrow text-coral">Danger zone</div>
            <p className="mt-0.5 font-mono text-xs text-muted">
              Reboot gb10 to recover a wedged GPU. Interrupts serving for ~2 minutes.
            </p>
          </div>
        </div>

        <AlertDialog.Root>
          <AlertDialog.Trigger asChild>
            <Button variant="danger" disabled={rebooting}>
              <RotateCcw className="h-3.5 w-3.5" /> {rebooting ? "Rebooting…" : "Reboot gb10"}
            </Button>
          </AlertDialog.Trigger>
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in" />
            <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-coral/40 bg-panel p-6 shadow-bay">
              <AlertDialog.Title className="font-display text-xl font-bold text-ink">
                Reboot gb10?
              </AlertDialog.Title>
              <AlertDialog.Description className="mt-2 font-mono text-[13px] leading-relaxed text-muted">
                This power-cycles the box. Any loaded model is dropped and all serving stops until
                gb10 comes back (~2 min). Reconnect and load a model afterward.
              </AlertDialog.Description>
              <div className="mt-6 flex justify-end gap-3">
                <AlertDialog.Cancel asChild>
                  <Button variant="ghost">Cancel</Button>
                </AlertDialog.Cancel>
                <AlertDialog.Action asChild>
                  <Button variant="danger" onClick={onReboot}>
                    Reboot now
                  </Button>
                </AlertDialog.Action>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      </div>
    </section>
  );
}
```

Replace it entirely with:

```tsx
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { Power, PowerOff, RotateCcw } from "lucide-react";
import { Button } from "./ui";

export function DangerZone({
  onReboot,
  rebooting,
  onPowerOff,
  poweringOff,
}: {
  onReboot: () => void;
  rebooting: boolean;
  onPowerOff: () => void;
  poweringOff: boolean;
}) {
  const disabled = rebooting || poweringOff;
  return (
    <section className="rounded-xl border border-coral/25 bg-coral/[0.04] px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Power className="h-5 w-5 shrink-0 text-coral" />
          <div className="min-w-0">
            <div className="eyebrow text-coral">Danger zone</div>
            <p className="mt-0.5 font-mono text-xs text-muted">
              Reboot to recover a wedged GPU (~2 min). Power off to shut gb10 down entirely — it
              stays off until you bring it back.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <AlertDialog.Root>
            <AlertDialog.Trigger asChild>
              <Button variant="danger" disabled={disabled}>
                <RotateCcw className="h-3.5 w-3.5" /> {rebooting ? "Rebooting…" : "Reboot gb10"}
              </Button>
            </AlertDialog.Trigger>
            <AlertDialog.Portal>
              <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in" />
              <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-coral/40 bg-panel p-6 shadow-bay">
                <AlertDialog.Title className="font-display text-xl font-bold text-ink">
                  Reboot gb10?
                </AlertDialog.Title>
                <AlertDialog.Description className="mt-2 font-mono text-[13px] leading-relaxed text-muted">
                  This power-cycles the box. Any loaded model is dropped and all serving stops until
                  gb10 comes back (~2 min). Reconnect and load a model afterward.
                </AlertDialog.Description>
                <div className="mt-6 flex justify-end gap-3">
                  <AlertDialog.Cancel asChild>
                    <Button variant="ghost">Cancel</Button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild>
                    <Button variant="danger" onClick={onReboot}>
                      Reboot now
                    </Button>
                  </AlertDialog.Action>
                </div>
              </AlertDialog.Content>
            </AlertDialog.Portal>
          </AlertDialog.Root>

          <AlertDialog.Root>
            <AlertDialog.Trigger asChild>
              <Button variant="danger" disabled={disabled}>
                <PowerOff className="h-3.5 w-3.5" /> {poweringOff ? "Powering off…" : "Power off gb10"}
              </Button>
            </AlertDialog.Trigger>
            <AlertDialog.Portal>
              <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in" />
              <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-coral/40 bg-panel p-6 shadow-bay">
                <AlertDialog.Title className="font-display text-xl font-bold text-ink">
                  Power off gb10?
                </AlertDialog.Title>
                <AlertDialog.Description className="mt-2 font-mono text-[13px] leading-relaxed text-muted">
                  This fully powers off gb10. Unlike reboot, it will <strong>not</strong> come back on
                  its own — it stays off until you power it back on. Any loaded model is dropped and
                  all serving stops until then.
                </AlertDialog.Description>
                <div className="mt-6 flex justify-end gap-3">
                  <AlertDialog.Cancel asChild>
                    <Button variant="ghost">Cancel</Button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild>
                    <Button variant="danger" onClick={onPowerOff}>
                      Power off now
                    </Button>
                  </AlertDialog.Action>
                </div>
              </AlertDialog.Content>
            </AlertDialog.Portal>
          </AlertDialog.Root>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Type-check the frontend**

Run: `cd swap-ui/frontend && npx tsc --noEmit`
Expected: no errors (this resolves the `DangerZoneProps` mismatch left over from Task 2).

- [ ] **Step 3: Build the frontend**

Run: `cd swap-ui/frontend && npm run build`
Expected: build succeeds, `dist/` is regenerated with no errors.

- [ ] **Step 4: Manual verification in the browser**

Run the dev server (`cd swap-ui/frontend && npm run dev`, or serve the built `dist/` via the running `swap-ui` backend) and in the browser:
1. Confirm the Danger Zone now shows two buttons: "Reboot gb10" and "Power off gb10".
2. Click "Power off gb10" — confirm the dialog opens with the title "Power off gb10?" and the described body text, and that "Cancel" closes it without calling the API.
3. With the browser's network tab open, click "Power off now" — confirm a `POST /api/poweroff` request fires, the dialog closes, and the notice banner shows "gb10 is powering off — bring it back up when you're ready to reconnect" in coral.
4. Reload the page (undoing the in-memory `poweringOff: true` state) and confirm both buttons are clickable again — this is expected per the Global Constraints (state is never auto-reset; a fresh page load starts clean).
5. Repeat steps 2-3 for "Reboot gb10" to confirm it still works unchanged, and that while one dialog's action is in flight (state `true`), both buttons show `disabled`.

- [ ] **Step 5: Commit**

```bash
git add swap-ui/frontend/src/components/DangerZone.tsx
git commit -m "frontend: add Power off gb10 button and confirmation dialog"
```
