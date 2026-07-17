import { Check, Download, FlaskConical, ArrowUpRight, GitCommitVertical, Trash2, FileEdit, Settings2 } from "lucide-react";
import type { Model } from "../api";
import { cn } from "../lib/cn";
import { Button, Pill } from "./ui";

export function ModelCard({
  model,
  isCurrent,
  busy,
  onLoad,
  onPromote,
  onRemove,
  onEdit,
}: {
  model: Model;
  isCurrent: boolean;
  busy: boolean;
  onLoad: () => void;
  onPromote: () => void;
  onRemove: () => void;
  onEdit: () => void;
}) {
  const loadable = model.downloaded && !isCurrent && !busy;
  const isDraft = model.source === "draft";

  return (
    <div
      className={cn(
        "group relative flex flex-col rounded-xl border bg-panel/70 p-5 transition-all duration-200",
        isCurrent
          ? "border-signal/50 shadow-glow"
          : "border-line hover:-translate-y-0.5 hover:border-cyan/40",
        !model.downloaded && "opacity-70",
      )}
    >
      {isCurrent && (
        <span className="absolute -top-px left-6 h-px w-16 bg-gradient-to-r from-transparent via-signal to-transparent" />
      )}

      <div className="mb-3 flex items-start justify-between gap-3">
        <h3 className="font-display text-lg font-semibold leading-snug text-ink">{model.label}</h3>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {isCurrent && (
            <Pill tone="signal" dot>
              In bay
            </Pill>
          )}
          {model.experimental && !isCurrent && (
            <Pill tone="amber">
              <FlaskConical className="h-3 w-3" /> Exp
            </Pill>
          )}
          {isDraft && (
            <Pill tone="cyan">
              <FileEdit className="h-3 w-3" /> Draft
            </Pill>
          )}
        </div>
      </div>

      <p className="mb-3 font-mono text-[12px] leading-relaxed text-muted">{model.desc}</p>

      {/* specs: memory · type · context (from size) + decode speed */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {model.size
          .split("·")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s, i) => (
            <span key={i} className="rounded border border-line bg-panel2 px-2 py-0.5 font-mono text-[10px] text-ink/80">
              {s}
            </span>
          ))}
        {model.speed && (
          <span className="rounded border border-cyan/30 bg-cyan/[0.06] px-2 py-0.5 font-mono text-[10px] text-cyan">
            {model.speed}
          </span>
        )}
      </div>

      {/* what to reach for it for */}
      {model.use_cases.length > 0 && (
        <div className="mb-3">
          <div className="eyebrow mb-1.5">Best for</div>
          <div className="flex flex-wrap gap-1.5">
            {model.use_cases.map((u, i) => (
              <span key={i} className="rounded-full border border-signal/25 bg-signal/[0.06] px-2 py-0.5 font-mono text-[10px] text-signal/90">
                {u}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1" />
      <div className="mb-3 truncate font-mono text-[11px] text-muted">{model.served_name}</div>

      <div className="flex items-center justify-between">
        {model.downloaded ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-signal/80">
            <Check className="h-3.5 w-3.5" /> On disk
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted">
            <Download className="h-3.5 w-3.5" /> Pre-pull required
          </span>
        )}

        {isCurrent ? (
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-signal">Active</span>
        ) : (
          <Button
            variant="solid"
            tone="cyan"
            disabled={!loadable}
            onClick={onLoad}
            title={!model.downloaded ? "Weights not downloaded on gb10" : undefined}
          >
            Load <ArrowUpRight className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-4 border-t border-line pt-3">
        {isDraft ? (
          <button
            onClick={onPromote}
            disabled={model.experimental || busy}
            title={model.experimental ? "Pass the stability tests to leave experimental first" : "Commit to the configs repo"}
            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-signal transition-colors hover:text-signal/80 disabled:cursor-not-allowed disabled:text-muted disabled:opacity-60"
          >
            <GitCommitVertical className="h-3.5 w-3.5" /> Promote
          </button>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted/60">committed</span>
        )}
        <div className="flex items-center gap-3">
          <button
            onClick={onEdit}
            title="Hand-edit the vLLM serve recipe"
            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted transition-colors hover:text-cyan"
          >
            <Settings2 className="h-3.5 w-3.5" /> Edit
          </button>
          <button
            onClick={onRemove}
            disabled={isCurrent || busy}
            title={isCurrent ? "Unload the model before removing it" : "Remove this model"}
            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted transition-colors hover:text-coral disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" /> Remove
          </button>
        </div>
      </div>
    </div>
  );
}
