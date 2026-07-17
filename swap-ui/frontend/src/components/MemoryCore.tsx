import { cn } from "../lib/cn";

type CoreState = "healthy" | "idle" | "swapping" | "wedged";

const CELLS = 48;

const toneClass: Record<string, string> = {
  signal: "bg-signal",
  cyan: "bg-cyan",
  amber: "bg-amber",
  coral: "bg-coral",
};

// Generic segmented "core" meter — the signature readout, reused for memory and utilization.
export function SegmentMeter({
  label,
  right,
  pct,
  tone,
  hotWarn = false,
}: {
  label: string;
  right: React.ReactNode;
  pct: number | null;
  tone: "signal" | "cyan" | "amber" | "coral";
  hotWarn?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, pct ?? 0));
  const lit = Math.round((clamped / 100) * CELLS);
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="eyebrow">{label}</span>
        <span className="font-mono text-sm text-ink">{right}</span>
      </div>
      <div
        className="flex gap-[3px] rounded-md border border-line bg-panel2 p-2"
        role="meter"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        {Array.from({ length: CELLS }).map((_, i) => {
          const on = i < lit;
          const hot = on && hotWarn && i >= CELLS * 0.86; // saturation warning near full
          return (
            <div
              key={i}
              className={cn(
                "h-8 flex-1 rounded-[2px] transition-colors duration-500",
                on ? (hot ? "bg-amber" : toneClass[tone]) : "bg-[var(--fill-empty)]",
                on && "shadow-[0_0_8px_-2px_currentColor]",
              )}
            />
          );
        })}
      </div>
    </div>
  );
}

// Unified-memory pool — the one bay's scarce resource. Near-full cells warn amber.
export function MemoryCore({
  usedMb,
  totalMb,
  state,
}: {
  usedMb?: number;
  totalMb?: number;
  state: CoreState;
}) {
  const pct = totalMb && usedMb != null ? (usedMb / totalMb) * 100 : null;
  const usedGb = usedMb != null ? (usedMb / 1024).toFixed(1) : "—";
  const totalGb = totalMb ? (totalMb / 1024).toFixed(1) : "—";
  const tone = state === "wedged" ? "coral" : state === "swapping" ? "amber" : state === "idle" ? "cyan" : "signal";
  return (
    <SegmentMeter
      label="Unified memory"
      pct={pct}
      tone={tone}
      hotWarn
      right={
        <>
          <span className={state === "wedged" ? "text-coral" : "text-signal"}>{usedGb}</span>
          <span className="text-muted"> / {totalGb} GB</span>
        </>
      }
    />
  );
}

// GPU compute utilization — high is normal, so no saturation warning.
export function UtilMeter({ util, wedged }: { util?: number; wedged?: boolean }) {
  return (
    <SegmentMeter
      label="GPU utilization"
      pct={wedged ? 0 : (util ?? null)}
      tone={wedged ? "coral" : "cyan"}
      right={
        <>
          <span className="text-cyan">{util != null && !wedged ? util : "—"}</span>
          <span className="text-muted"> %</span>
        </>
      }
    />
  );
}
