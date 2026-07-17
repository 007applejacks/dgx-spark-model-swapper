import * as Dialog from "@radix-ui/react-dialog";
import {
  X, CheckCircle2, XCircle, MinusCircle, Loader2, Circle, FlaskConical, ShieldCheck, Gauge,
} from "lucide-react";
import type { TestJob, TestCase } from "../api";
import { cn } from "../lib/cn";
import { Eyebrow } from "./ui";

function StatusIcon({ status }: { status: TestCase["status"] }) {
  switch (status) {
    case "pass":
      return <CheckCircle2 className="h-4 w-4 text-signal" />;
    case "fail":
      return <XCircle className="h-4 w-4 text-coral" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-amber" />;
    case "skip":
      return <MinusCircle className="h-4 w-4 text-muted" />;
    default:
      return <Circle className="h-4 w-4 text-muted/40" />;
  }
}

function Tile({ label, value, tone = "ink" }: { label: string; value: string; tone?: string }) {
  const c = { ink: "text-ink", signal: "text-signal", amber: "text-amber", coral: "text-coral", cyan: "text-cyan" }[tone] || "text-ink";
  return (
    <div className="rounded-lg border border-line bg-panel2 px-3 py-2.5">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className={cn("mt-0.5 font-display text-lg font-semibold tabular-nums", c)}>{value}</div>
    </div>
  );
}

function metricChips(m: Record<string, string | number | null>) {
  return Object.entries(m)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => (
      <span key={k} className="rounded border border-line bg-bg/60 px-1.5 py-0.5 font-mono text-[10px] text-muted">
        {k.replace(/_/g, " ")} <span className="text-ink">{String(v)}</span>
      </span>
    ));
}

export function TestPanel({ job, onClose }: { job: TestJob | null; onClose: () => void }) {
  const open = job !== null && job.state !== "idle";
  const s = job?.report?.summary;
  const gpu = job?.report?.gpu;
  const running = job?.state === "running";

  const overall = running
    ? { tone: "amber" as const, label: "Running", Icon: Loader2, spin: true }
    : s?.all_passed
      ? { tone: "signal" as const, label: "Stable", Icon: ShieldCheck, spin: false }
      : { tone: "coral" as const, label: "Unstable", Icon: XCircle, spin: false };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[min(94vw,720px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-panel p-6 shadow-bay">
          <div className="mb-5 flex items-start justify-between">
            <div>
              <Eyebrow className="text-cyan">GB10 stability battery</Eyebrow>
              <Dialog.Title className="mt-1 flex items-center gap-2 font-display text-xl font-bold text-ink">
                <FlaskConical className="h-5 w-5 text-cyan" />
                {job?.served_name || "model"}
              </Dialog.Title>
            </div>
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.14em]",
                  { signal: "border-signal/40 bg-signal/10 text-signal", amber: "border-amber/40 bg-amber/10 text-amber", coral: "border-coral/40 bg-coral/10 text-coral" }[overall.tone],
                )}
              >
                <overall.Icon className={cn("h-3.5 w-3.5", overall.spin && "animate-spin")} />
                {overall.label}
              </span>
              <Dialog.Close className="text-muted hover:text-ink" aria-label="Close">
                <X className="h-5 w-5" />
              </Dialog.Close>
            </div>
          </div>

          {job?.experimental_cleared && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-signal/40 bg-signal/[0.08] px-4 py-2.5 font-mono text-[12px] text-signal">
              <ShieldCheck className="h-4 w-4" /> Passed every check — experimental tag removed.
            </div>
          )}

          {/* report tiles */}
          <div className="mb-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Tile label="Passed" value={s ? `${s.passed}/${s.ran}` : "—"} tone={s?.all_passed ? "signal" : s ? "coral" : "ink"} />
            <Tile label="Decode" value={s?.decode_tok_s != null ? `${s.decode_tok_s} tok/s` : "—"} tone="cyan" />
            <Tile label="Tool gate" value={s?.tool_gate || "—"} />
            <Tile label="GPU mem" value={gpu?.mem_pct != null ? `${gpu.mem_pct}%` : "—"} />
          </div>

          {job?.report?.error && (
            <p className="mb-4 font-mono text-[12px] text-coral">Error: {job.report.error}</p>
          )}

          {/* per-test rows */}
          <div className="space-y-1.5">
            {(job?.tests || []).map((t) => (
              <div
                key={t.name}
                className={cn(
                  "rounded-lg border px-3.5 py-2.5",
                  t.status === "fail" ? "border-coral/40 bg-coral/[0.05]" : "border-line bg-panel2/60",
                )}
              >
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <StatusIcon status={t.status} />
                    <span className="font-display text-sm font-medium text-ink">{t.title}</span>
                  </div>
                  <span className="pl-7 font-mono text-[10px] uppercase tracking-[0.12em] text-muted sm:pl-0 sm:text-right">
                    catches: {t.targets}
                  </span>
                </div>
                {(t.detail || Object.keys(t.metrics || {}).length > 0) && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-7">
                    {t.detail && <span className="font-mono text-[11px] text-muted">{t.detail}</span>}
                    {metricChips(t.metrics || {})}
                  </div>
                )}
              </div>
            ))}
          </div>

          {gpu && (
            <div className="mt-4 flex items-center gap-4 border-t border-line pt-3 font-mono text-[11px] text-muted">
              <Gauge className="h-3.5 w-3.5" />
              <span>GPU {gpu.name}</span>
              {gpu.util_pct != null && <span>util {gpu.util_pct}%</span>}
              {gpu.temp_c != null && <span>{gpu.temp_c}°C</span>}
              {job?.report?.finish_reasons && (
                <span>finish: {Object.entries(job.report.finish_reasons).map(([k, v]) => `${k}×${v}`).join("  ")}</span>
              )}
              {s?.empty_responses && <span>empty: {s.empty_responses}</span>}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
