import * as Dialog from "@radix-ui/react-dialog";
import {
  X, CheckCircle2, XCircle, MinusCircle, Loader2, Circle, FlaskConical, ShieldCheck, Gauge,
} from "lucide-react";
import type { TestJob, ThroughputJob } from "../api";
import { cn } from "../lib/cn";
import { Eyebrow } from "./ui";

function StatusIcon({ status }: { status: "pass" | "fail" | "running" | "skip" | "pending" }) {
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

function MetricRow({ label, value, unit = "" }: { label: string; value: string | number | null; unit?: string }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex items-baseline gap-1 font-mono text-[11px] text-muted">
      <span>{label}</span>
      <span className="text-ink font-medium">{value}</span>
      {unit && <span>{unit}</span>}
    </div>
  );
}

function BenchmarkPhase({ 
  title, 
  phase, 
  passed, 
  error, 
  metrics, 
  raw, 
  currentPhase 
}: { 
  title: string; 
  phase: string; 
  passed: boolean; 
  error: string | null; 
  metrics: Record<string, any>; 
  raw: string; 
  currentPhase: string;
}) {
  const isRunning = currentPhase === phase;
  
  const status = error ? "fail" : passed ? "pass" : isRunning ? "running" : "pending";
  
  return (
    <div className={cn(
      "rounded-lg border px-3.5 py-2.5 transition-colors",
      error ? "border-coral/40 bg-coral/[0.05]" : 
      passed ? "border-signal/30 bg-signal/[0.05]" : 
      isRunning ? "border-amber/40 bg-amber/[0.05]" : "border-line bg-panel2/60"
    )}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <StatusIcon status={status} />
          <span className="font-display text-sm font-medium text-ink">{title}</span>
          {isRunning && <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-amber">running…</span>}
        </div>
        <div className="pl-7 flex flex-wrap items-center gap-1.5 sm:pl-0 sm:text-right">
          {error && <span className="font-mono text-[11px] text-coral">Error: {error.slice(0, 80)}</span>}
          {!error && metrics && Object.keys(metrics).length > 0 && (
            <>
              {metrics.throughput_tok_s && (
                <MetricRow label="Throughput" value={metrics.throughput_tok_s.toFixed(1)} unit=" tok/s" />
              )}
              {metrics.avg_latency_ms && (
                <MetricRow label="Avg Latency" value={metrics.avg_latency_ms.toFixed(1)} unit=" ms" />
              )}
              {metrics.ttft_ms && (
                <MetricRow label="TTFT" value={metrics.ttft_ms.toFixed(1)} unit=" ms" />
              )}
              {metrics.successful_requests !== undefined && (
                <MetricRow label="Success" value={metrics.successful_requests} />
              )}
              {metrics.failed_requests && metrics.failed_requests > 0 && (
                <MetricRow label="Failed" value={metrics.failed_requests} />
              )}
              {Object.entries(metrics).map(([k, v]) => {
                if (["throughput_tok_s", "avg_latency_ms", "ttft_ms", "successful_requests", "failed_requests"].includes(k)) return null;
                return <MetricRow key={k} label={k.replace(/_/g, " ")} value={String(v)} />;
              })}
            </>
          )}
        </div>
      </div>
      {raw && (
        <details className="mt-2">
          <summary className="font-mono text-[10px] text-muted cursor-pointer">Raw output</summary>
          <pre className="mt-1 rounded bg-bg/50 p-2 font-mono text-[10px] text-muted overflow-x-auto whitespace-pre-wrap">{raw.slice(0, 2000)}</pre>
        </details>
      )}
    </div>
  );
}

function EvaluationResults({ evaluation, error, currentPhase }: { 
  evaluation: Record<string, any>; 
  error: string | null; 
  currentPhase: string;
}) {
  const isRunning = currentPhase === "evaluation";
  
  if (!evaluation && !error) {
    return (
      <div className="rounded-lg border border-line bg-panel2/60 px-3.5 py-2.5">
        <div className="flex items-center gap-2.5">
          <StatusIcon status={isRunning ? "running" : "pending"} />
          <span className="font-display text-sm font-medium text-ink">Quality Evaluation (lm-eval-harness)</span>
          {isRunning && <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-amber">running…</span>}
        </div>
      </div>
    );
  }
  
  const tasks = evaluation?.tasks || {};
  const taskEntries = Object.entries(tasks);
  
  return (
    <div className={cn(
      "rounded-lg border px-3.5 py-2.5",
      error ? "border-coral/40 bg-coral/[0.05]" : "border-line bg-panel2/60"
    )}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="flex items-center gap-2.5">
          <StatusIcon status={error ? "fail" : isRunning ? "running" : taskEntries.length > 0 ? "pass" : "skip"} />
          <span className="font-display text-sm font-medium text-ink">Quality Evaluation (lm-eval-harness)</span>
          {isRunning && <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-amber">running…</span>}
        </div>
        {error && <span className="font-mono text-[11px] text-coral">Error: {error.slice(0, 100)}</span>}
      </div>
      
      {taskEntries.length > 0 && (
        <div className="mt-2 space-y-1">
          {taskEntries.map(([taskName, metrics]) => (
            <div key={taskName} className="flex flex-wrap items-center gap-2 pl-7">
              <span className="font-mono text-[11px] text-muted min-w-[120px]">{taskName}</span>
              {Object.entries(metrics as Record<string, number>).map(([metric, value]) => (
                <span key={metric} className="rounded border border-line bg-bg/60 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                  {metric} <span className="text-ink">{typeof value === "number" ? value.toFixed(4) : value}</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TestPanel({ job, onClose }: { job: TestJob | null; onClose: () => void }) {
  const open = job !== null && job.state !== "idle";
  const benchmark = job?.benchmark || job?.report;
  const running = job?.state === "running";
  const currentPhase = benchmark?.config ?
    (benchmark.serving_error === null && benchmark.evaluation_error === null ? "done" :
     benchmark.evaluation_error !== null || (benchmark.evaluation && !benchmark.evaluation_error) ? "evaluation" :
     "serving") : "starting";

  const overall = running
    ? { tone: "amber" as const, label: "Running", Icon: Loader2, spin: true }
    : benchmark?.all_passed
      ? { tone: "signal" as const, label: "All Passed", Icon: ShieldCheck, spin: false }
      : { tone: "coral" as const, label: "Issues Found", Icon: XCircle, spin: false };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[min(94vw,880px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-panel p-6 shadow-bay">
          <div className="mb-5 flex items-start justify-between">
            <div>
              <Eyebrow className="text-cyan">Standard benchmark suite</Eyebrow>
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

          {/* Summary tiles */}
          <div className="mb-5 grid grid-cols-3 gap-2.5">
            <Tile
              label="Serving"
              value={benchmark?.serving_passed ? "✓" : benchmark?.serving_error ? "✗" : "⋯"}
              tone={benchmark?.serving_passed ? "signal" : benchmark?.serving_error ? "coral" : "amber"}
            />
            <Tile
              label="Quality"
              value={benchmark?.evaluation_passed ? "✓" : benchmark?.evaluation_error ? "✗" : "⋯"}
              tone={benchmark?.evaluation_passed ? "signal" : benchmark?.evaluation_error ? "coral" : "amber"}
            />
            <Tile
              label="GPU Mem"
              value={benchmark?.gpu_snapshot?.mem_pct != null ? `${benchmark.gpu_snapshot.mem_pct}%` : "—"}
              tone="cyan"
            />
          </div>

          {benchmark?.serving_error && (
            <p className="mb-4 font-mono text-[12px] text-coral">Serving Error: {benchmark.serving_error}</p>
          )}
          {benchmark?.evaluation_error && (
            <p className="mb-4 font-mono text-[12px] text-coral">Evaluation Error: {benchmark.evaluation_error}</p>
          )}

          {/* Phase results */}
          <div className="space-y-3">
            {benchmark && (
              <>
                <BenchmarkPhase
                  title="Serving Benchmark (vllm bench serve)"
                  phase="serving"
                  passed={benchmark.serving_passed}
                  error={benchmark.serving_error}
                  metrics={benchmark.serving}
                  raw={benchmark.serving_raw}
                  currentPhase={currentPhase}
                />
                <EvaluationResults
                  evaluation={benchmark.evaluation}
                  error={benchmark.evaluation_error}
                  currentPhase={currentPhase}
                />
              </>
            )}
          </div>

          {benchmark?.gpu_snapshot && (
            <div className="mt-4 flex items-center gap-4 border-t border-line pt-3 font-mono text-[11px] text-muted">
              <Gauge className="h-3.5 w-3.5" />
              <span>GPU {benchmark.gpu_snapshot.name}</span>
              {benchmark.gpu_snapshot.util_pct != null && <span>util {benchmark.gpu_snapshot.util_pct}%</span>}
              {benchmark.gpu_snapshot.temp_c != null && <span>{benchmark.gpu_snapshot.temp_c}°C</span>}
              {benchmark.gpu_snapshot.mem_pct != null && <span>mem {benchmark.gpu_snapshot.mem_pct}%</span>}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const THROUGHPUT_PHASE_LABEL: Record<string, string> = {
  stopping: "Stopping current model…",
  draining: "Draining GPU…",
  benchmarking: "Running offline throughput benchmark…",
  reloading: "Reloading original model…",
};

export function ThroughputPanel({ job, onClose }: { job: ThroughputJob | null; onClose: () => void }) {
  const open = job !== null && job.state !== "idle";
  const running = job?.state === "running";
  const result = job && "throughput" in job.result ? job.result : null;

  const overall = running
    ? { tone: "amber" as const, label: job.phase ? THROUGHPUT_PHASE_LABEL[job.phase] ?? "Running" : "Running", Icon: Loader2, spin: true }
    : job?.state === "done"
      ? { tone: "signal" as const, label: "Benchmarked & reloaded", Icon: ShieldCheck, spin: false }
      : { tone: "coral" as const, label: "Issues found", Icon: XCircle, spin: false };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[min(94vw,720px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-panel p-6 shadow-bay">
          <div className="mb-5 flex items-start justify-between">
            <div>
              <Eyebrow className="text-cyan">Offline throughput benchmark</Eyebrow>
              <Dialog.Title className="mt-1 flex items-center gap-2 font-display text-xl font-bold text-ink">
                <Gauge className="h-5 w-5 text-cyan" />
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

          {running && (
            <p className="mb-4 font-mono text-[12px] text-amber">
              Model is offline right now — it will reload automatically once the benchmark finishes.
            </p>
          )}

          {job?.state === "error" && job.reload_ok === false && (
            <p className="mb-4 font-mono text-[12px] text-coral">
              The original model failed to reload — check the dashboard and reload it manually if needed.
            </p>
          )}

          {result?.throughput_error && (
            <p className="mb-4 font-mono text-[12px] text-coral">Benchmark error: {result.throughput_error}</p>
          )}

          {result && (
            <BenchmarkPhase
              title="Offline Throughput (vllm bench throughput)"
              phase="benchmarking"
              passed={result.throughput_passed}
              error={result.throughput_error}
              metrics={result.throughput}
              raw={result.throughput_raw}
              currentPhase={job?.phase || ""}
            />
          )}

          {result?.gpu_snapshot && (
            <div className="mt-4 flex items-center gap-4 border-t border-line pt-3 font-mono text-[11px] text-muted">
              <span>GPU {result.gpu_snapshot.name}</span>
              {result.gpu_snapshot.util_pct != null && <span>util {result.gpu_snapshot.util_pct}%</span>}
              {result.gpu_snapshot.mem_pct != null && <span>mem {result.gpu_snapshot.mem_pct}%</span>}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
