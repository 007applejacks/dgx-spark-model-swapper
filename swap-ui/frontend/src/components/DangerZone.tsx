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
