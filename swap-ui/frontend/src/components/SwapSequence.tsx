import { AlertTriangle, DownloadCloud } from "lucide-react";
import { cn } from "../lib/cn";

// The swap procedure is a real 4-stage sequence emitted by the backend as PHASE markers.
// DRAIN is the hazard stage: an un-drained integrated GPU can wedge (reboot-only recovery).
interface Stage {
  key: string;
  label: string;
  note: string;
  hazard?: boolean;
}

const STAGES: Stage[] = [
  { key: "stopping", label: "Stop", note: "unload current" },
  { key: "draining", label: "Drain", note: "clear the GPU", hazard: true },
  { key: "starting", label: "Load", note: "start target" },
  { key: "waiting-health", label: "Health", note: "await ready" },
];

export function SwapSequence({
  phase,
  wedged,
  targetLabel,
  progress,
}: {
  phase: string | null;
  wedged: boolean;
  targetLabel: string;
  progress?: string | null;
}) {
  const activeIdx = STAGES.findIndex((s) => s.key === phase);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="eyebrow text-amber">Swap in progress</span>
        <span className="font-display text-sm text-ink">→ {targetLabel}</span>
      </div>
      {progress && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-cyan/30 bg-cyan/[0.05] px-3 py-2">
          <DownloadCloud className="h-3.5 w-3.5 shrink-0 text-cyan" />
          <span className="truncate font-mono text-[11px] text-muted">{progress}</span>
        </div>
      )}
      <ol className="grid grid-cols-4 gap-2">
        {STAGES.map((s, i) => {
          const done = activeIdx > i && !(wedged && s.key === "draining");
          const active = activeIdx === i && !wedged;
          const failed = wedged && s.key === "draining";
          return (
            <li
              key={s.key}
              className={cn(
                "relative overflow-hidden rounded-lg border px-3 py-3 transition-colors",
                failed && "border-coral/60 bg-coral/10",
                active && "border-amber/60 bg-amber/10",
                done && "border-signal/40 bg-signal/[0.06]",
                !active && !done && !failed && "border-line bg-panel2",
              )}
            >
              {active && (
                <span className="absolute inset-x-0 top-0 h-px overflow-hidden">
                  <span className="block h-full w-1/3 animate-sweep bg-gradient-to-r from-transparent via-amber to-transparent" />
                </span>
              )}
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    "font-mono text-[10px] tabular-nums",
                    done ? "text-signal" : active ? "text-amber" : failed ? "text-coral" : "text-muted",
                  )}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                {s.hazard && (
                  <AlertTriangle
                    className={cn("h-3 w-3", failed ? "text-coral" : active ? "text-amber" : "text-muted/60")}
                  />
                )}
              </div>
              <div
                className={cn(
                  "mt-1.5 font-display text-sm font-semibold",
                  active && "animate-pulseStage text-amber",
                  done && "text-signal",
                  failed && "text-coral",
                  !active && !done && !failed && "text-muted",
                )}
              >
                {s.label}
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-muted">{s.note}</div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
