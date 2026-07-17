import { useEffect, useState } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { Loader2 } from "lucide-react";
import type { Model } from "../api";
import { Button } from "./ui";

export function RemoveModelDialog({
  model,
  onClose,
  onConfirm,
}: {
  model: Model | null;
  onClose: () => void;
  onConfirm: (weights: boolean) => Promise<void>;
}) {
  const [weights, setWeights] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setWeights(false);
  }, [model?.id]);

  async function go() {
    setBusy(true);
    try {
      await onConfirm(weights);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog.Root open={model !== null} onOpenChange={(v) => !v && onClose()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-coral/40 bg-panel p-6 shadow-bay">
          <AlertDialog.Title className="font-display text-xl font-bold text-ink">
            Remove {model?.label}?
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 font-mono text-[13px] leading-relaxed text-muted">
            {model?.source === "committed" ? (
              <>Removes the recipe and <span className="text-ink">commits + pushes</span> the deletion to the model-configs repo.</>
            ) : (
              <>Discards this draft recipe (it was never committed).</>
            )}{" "}
            The stopped container is cleaned up.
          </AlertDialog.Description>

          {model?.downloaded && (
            <label className="mt-4 flex cursor-pointer items-center gap-2.5 rounded-md border border-line bg-panel2 px-3 py-2.5">
              <input
                type="checkbox"
                checked={weights}
                onChange={(e) => setWeights(e.target.checked)}
                className="h-4 w-4 accent-coral"
              />
              <span className="font-mono text-[12px] text-ink">
                Also delete downloaded weights <span className="text-muted">(frees disk)</span>
              </span>
            </label>
          )}

          <div className="mt-6 flex justify-end gap-3">
            <AlertDialog.Cancel asChild>
              <Button variant="ghost" disabled={busy}>Cancel</Button>
            </AlertDialog.Cancel>
            <Button variant="danger" onClick={() => void go()} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Remove
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
