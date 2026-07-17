import { useCallback, useEffect, useState } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { HardDrive, Trash2, Loader2, Sparkles } from "lucide-react";
import { api, type DiskInfo, type DiskModel } from "../api";
import { cn } from "../lib/cn";
import { Button, Eyebrow, Pill } from "./ui";

function gb(bytes: number): string {
  if (bytes >= 1e12) return (bytes / 1e12).toFixed(2) + " TB";
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + " MB";
  return (bytes / 1e3).toFixed(0) + " KB";
}

export function DiskPanel({ refreshSignal }: { refreshSignal?: number }) {
  const [info, setInfo] = useState<DiskInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // model id being deleted, or "clean"
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<DiskModel | null>(null);

  const load = useCallback(async () => {
    try {
      setInfo(await api.disk());
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  // Re-fetch on mount, and whenever the parent bumps refreshSignal (e.g. a model+weights removal
  // elsewhere freed space) so the disk stats never go stale behind an external change.
  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  async function del(m: DiskModel) {
    setBusy(m.id);
    setErr(null);
    try {
      await api.diskDelete(m.id);
      setConfirm(null);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function clean() {
    setBusy("clean");
    setErr(null);
    try {
      await api.diskClean();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const fs = info?.fs;
  const pct = fs?.pct ?? 0;

  return (
    <section className="rounded-xl border border-line bg-panel/70 px-6 py-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <HardDrive className="h-5 w-5 text-cyan" />
          <Eyebrow>Disk &amp; weights</Eyebrow>
        </div>
        {info && (
          <span className="font-mono text-[11px] text-muted">
            {gb(info.cache_bytes)} in weights
            {info.incomplete_bytes > 0 && <span className="text-amber"> · {gb(info.incomplete_bytes)} incomplete</span>}
          </span>
        )}
      </div>

      {/* filesystem usage bar */}
      {fs && (
        <div className="mb-4">
          <div className="mb-1.5 flex items-baseline justify-between font-mono text-[12px]">
            <span className="text-muted">Disk (/)</span>
            <span className="text-ink">
              <span className={pct >= 90 ? "text-coral" : pct >= 75 ? "text-amber" : "text-signal"}>{gb(fs.used)}</span>
              <span className="text-muted"> / {gb(fs.total)} · {gb(fs.free)} free</span>
            </span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full border border-line bg-panel2">
            <div
              className={cn("h-full rounded-full transition-all", pct >= 90 ? "bg-coral" : pct >= 75 ? "bg-amber" : "bg-signal")}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {err && <p className="mb-3 font-mono text-[12px] text-coral">{err}</p>}

      {info?.incomplete_bytes ? (
        <div className="mb-3 flex items-center justify-between rounded-md border border-amber/30 bg-amber/[0.05] px-3 py-2">
          <span className="font-mono text-[11px] text-amber">
            {gb(info.incomplete_bytes)} of aborted-download leftovers
          </span>
          <Button variant="ghost" onClick={() => void clean()} disabled={busy === "clean"}>
            {busy === "clean" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Clean
          </Button>
        </div>
      ) : null}

      {/* per-model weight sizes + delete */}
      <div className="space-y-1.5">
        {info?.models.length === 0 && (
          <div className="font-mono text-[12px] text-muted">No downloaded weights.</div>
        )}
        {info?.models.map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-3 rounded-md border border-line bg-panel2 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-[12px] text-ink">{m.label}</span>
              {m.loaded && <Pill tone="signal">loaded</Pill>}
              {m.loading && <Pill tone="amber">downloading…</Pill>}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="font-mono text-[12px] tabular-nums text-muted">{gb(m.bytes)}</span>
              <button
                onClick={() => setConfirm(m)}
                disabled={m.loaded || m.loading || busy === m.id}
                title={
                  m.loaded
                    ? "Unload the model before deleting its weights"
                    : m.loading
                      ? "A download/swap for this model is in progress — wait for it to finish before deleting"
                      : "Delete weights"
                }
                className="inline-flex items-center gap-1 font-mono text-[11px] text-muted transition-colors hover:text-coral disabled:opacity-30"
              >
                {busy === m.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        ))}
      </div>

      <AlertDialog.Root open={confirm !== null} onOpenChange={(v) => !v && setConfirm(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-coral/40 bg-panel p-6 shadow-bay">
            <AlertDialog.Title className="font-display text-xl font-bold text-ink">Delete weights?</AlertDialog.Title>
            <AlertDialog.Description className="mt-2 font-mono text-[13px] leading-relaxed text-muted">
              Removes <span className="text-ink">{confirm?.label}</span> ({confirm ? gb(confirm.bytes) : ""}) from the
              HF cache. The recipe stays; you'd re-download the weights to serve it again.
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-3">
              <AlertDialog.Cancel asChild>
                <Button variant="ghost">Cancel</Button>
              </AlertDialog.Cancel>
              <Button variant="danger" onClick={() => confirm && void del(confirm)}>
                Delete
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}
