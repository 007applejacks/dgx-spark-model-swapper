# Power off button — dashboard Danger Zone

## Purpose

The dashboard's Danger Zone (`DangerZone.tsx`) currently has one action: "Reboot gb10", which
power-cycles the box to recover a wedged GPU. There's no way to fully power the box **off** from
the dashboard — only reboot (comes back on its own) or Unload (stops the served model, box stays
up). This adds a sibling "Power off gb10" action, for cases where the box should go down and stay
down (e.g. before physically moving it, or overnight when it won't be used and the owner wants to
power-cycle a smart plug remotely to bring it back later).

This is a straight structural sibling to the existing, working Reboot flow — same request pattern,
same fire-and-forget semantics, same lack of gating on in-flight jobs. The only real design
question was severity of the confirmation copy, addressed below.

## Non-goals

- No in-app tracking of *how* the box gets powered back on (smart plug / BMC / WoL) — the
  confirmation dialog stays generic per explicit direction from the design discussion, not tied to
  any specific mechanism.
- No gating on in-flight swaps/tests/benchmarks — matches `/api/reboot`'s existing behavior. This
  is an escape hatch, not a normal operation; it should never be blockable by app state.
- No countdown/auto-reconnect UI (reboot's "~2 min" framing doesn't apply — power off has no
  known return time).
- No changes to the Unload button or GpuBay — that flow already covers "stop serving, box stays
  up" and is unaffected.

## Backend — `POST /api/poweroff`

New endpoint in `swap-ui/app.py`, placed next to `/api/reboot` (currently line 797), structurally
identical:

```python
@app.post("/api/poweroff")
async def api_poweroff() -> dict[str, Any]:
    # Needs passwordless sudo for /sbin/poweroff (see swap-ui/README.md). Fire-and-forget; this
    # process dies with the box. Scheduled slightly delayed so the HTTP response flushes.
    if not shutil.which("sudo"):
        raise HTTPException(500, "sudo not available")
    subprocess.Popen(["bash", "-c", "sleep 1; sudo /sbin/poweroff"])
    return {"poweringOff": True}
```

No gating checks (mirrors `/api/reboot`, which also has none) — a swap/test/benchmark in progress
must not be able to block this.

## Sudoers requirement (new, must ship alongside the endpoint)

Exactly like `/sbin/reboot` today, `/sbin/poweroff` needs its own passwordless sudoers grant for
the swap-ui service user, or the button silently does nothing (the endpoint returns success
without checking whether `sudo` actually worked). Two places already document/automate the reboot
grant and both need the poweroff line added alongside it:

1. **`swap-ui/README.md`** — the existing "Reboot button — sudoers requirement" section becomes
   "Reboot / power off buttons — sudoers requirement", with both lines shown:
   ```
   # /etc/sudoers.d/gb10-swap-reboot   (chmod 440, edit via visudo -f)
   deploy ALL=(root) NOPASSWD: /sbin/reboot, /sbin/poweroff
   ```
   Same "fails silently, not loudly" warning, extended to mention poweroff.

2. **`install.sh`**'s post-install manual-follow-ups block (currently ~line 335-337) — update the
   echoed sudoers line the same way, so a fresh install's instructions are correct from day one.

(Using one sudoers line with both commands, rather than two separate drop-in files, keeps this to
a one-line diff in both places and matches how a human would extend the existing grant by hand.)

## Frontend

**`api.ts`** — one new call, same shape as `reboot()`:
```ts
poweroff: () => fetch("/api/poweroff", { method: "POST" }).then(j<{ poweringOff: boolean }>),
```

**`App.tsx`**:
- New `poweringOff` state (`useState(false)`), alongside the existing `rebooting` state.
- New `onPowerOff` handler, mirroring `onReboot` (currently lines 261-269):
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
  Notice tone is `coral` (vs. reboot's `amber`) to visually distinguish "this is more final" —
  consistent with the Danger Zone's coral accent color used for its riskiest actions elsewhere.
  `poweringOff` is never reset to `false` (same as `rebooting` today — the box going down makes
  further state tracking moot; the user reloads the page once it's back).
- `poweringOff` added to the existing `busy` computation (line 347):
  `const busy = swapping || rebooting || poweringOff || testing || throughputBenchmarking;`
- `DangerZone` invocation (line 451) passes both action pairs through:
  `<DangerZone onReboot={onReboot} rebooting={rebooting} onPowerOff={onPowerOff} poweringOff={poweringOff} />`

**`DangerZone.tsx`** — extend props and render a second button + dialog:
- Props become `{ onReboot, rebooting, onPowerOff, poweringOff }`.
- Layout: keep the existing left-hand icon/label/description block, but broaden the description to
  cover both actions (e.g. "Reboot to recover a wedged GPU (~2 min). Power off to shut gb10 down
  entirely — it stays off until you bring it back."). Two buttons sit on the right, each with its
  own `AlertDialog.Root`/confirmation, same as the existing Reboot dialog's structure.
- New button: `Power off gb10` — icon `PowerOff` from `lucide-react` (already used elsewhere in
  this codebase for the Unload button, so it reads consistently as "this turns something off"),
  `variant="danger"`, disabled while `rebooting || poweringOff`.
- Existing Reboot button also gets `disabled={rebooting || poweringOff}` (currently just
  `rebooting`) — the two terminal actions shouldn't be triggerable simultaneously.
- New dialog copy:
  - Title: "Power off gb10?"
  - Description: "This fully powers off gb10. Unlike reboot, it will **not** come back on its
    own — it stays off until you power it back on. Any loaded model is dropped and all serving
    stops until then."
  - Confirm button label: "Power off now" (same single-click confirm pattern as Reboot — no typed
    confirmation, consistent with how Reboot is already gated only by the AlertDialog, not by a
    stronger mechanism).

## Testing

No unit test suite exists for this frontend/backend pair today (reboot has none either) — this
follows the same manual-verification bar:
- `curl -X POST http://localhost:8080/api/poweroff` on a box *without* the sudoers grant yet:
  confirm it returns `{"poweringOff": true}` (the silent-failure mode is expected/documented, not
  a bug to fix here — matches reboot's existing behavior).
- With the sudoers grant installed: confirm the box actually powers off.
- Frontend: confirm both dialogs render, confirm/cancel both work, confirm the two buttons disable
  each other correctly while either is in flight.
