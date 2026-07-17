import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Loader2, Search, TriangleAlert, X, Save } from "lucide-react";
import { api, type HfLookup, type Model } from "../api";
import { Button, Eyebrow, Pill } from "./ui";

function gb(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + " MB";
  return bytes ? (bytes / 1e3).toFixed(0) + " KB" : "unknown";
}

export function RecipeEditorDialog({
  model,
  onClose,
  onSaved,
}: {
  model: Model | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState("");
  const [repo, setRepo] = useState("");
  const [source, setSource] = useState("committed");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [lookup, setLookup] = useState<HfLookup | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupErr, setLookupErr] = useState<string | null>(null);

  useEffect(() => {
    if (!model) return;
    setLoading(true);
    setErr(null);
    setLookup(null);
    setLookupErr(null);
    api
      .modelEnv(model.id)
      .then((r) => {
        setText(r.env);
        setRepo(r.repo);
        setSource(r.source);
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, [model?.id]);

  async function doLookup() {
    if (!model) return;
    setLookupBusy(true);
    setLookupErr(null);
    try {
      setLookup(await api.modelHfLookup(model.id));
    } catch (e) {
      setLookupErr((e as Error).message);
    } finally {
      setLookupBusy(false);
    }
  }

  async function save() {
    if (!model) return;
    setSaving(true);
    setErr(null);
    try {
      await api.saveModelEnv(model.id, text);
      onSaved();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={model !== null} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(96vw,900px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-panel p-6 shadow-bay">
          <div className="mb-5 flex items-start justify-between">
            <div>
              <Eyebrow className="text-cyan">Recipe editor</Eyebrow>
              <Dialog.Title className="mt-1 flex items-center gap-2 font-display text-xl font-bold text-ink">
                {model?.label}
                {source === "draft" && <Pill tone="cyan">draft</Pill>}
                {source === "committed" && <Pill tone="muted">committed</Pill>}
              </Dialog.Title>
            </div>
            <Dialog.Close className="text-muted hover:text-ink" aria-label="Close">
              <X className="h-5 w-5" />
            </Dialog.Close>
          </div>

          <p className="mb-4 font-mono text-[11px] leading-relaxed text-muted">
            Hand-edit the raw <span className="text-cyan">{model?.id}.env</span> recipe. Changes apply on the{" "}
            <span className="text-ink">next Load</span> — they don't affect a currently-running container. Saving a
            committed recipe turns it into a draft again; use Promote on the card to commit it.
          </p>

          <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-line bg-panel2 px-3 py-2.5">
            <span className="truncate font-mono text-[11px] text-muted">
              Authoritative source: <span className="text-ink">{repo || "(no SERVE_MODEL set)"}</span>
            </span>
            <Button variant="ghost" onClick={() => void doLookup()} disabled={!repo || lookupBusy}>
              {lookupBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              Look up on HF
            </Button>
          </div>

          {lookupErr && (
            <p className="mb-4 flex items-center gap-2 font-mono text-[12px] text-coral">
              <TriangleAlert className="h-4 w-4 shrink-0" /> {lookupErr}
            </p>
          )}

          {lookup && (
            <div className="mb-4 grid grid-cols-2 gap-2 rounded-md border border-cyan/30 bg-cyan/[0.05] p-3 sm:grid-cols-3">
              <Field label="Architecture" value={lookup.architecture || "—"} />
              <Field
                label="Native context"
                value={lookup.max_position_embeddings ? lookup.max_position_embeddings.toLocaleString() : "—"}
              />
              <Field label="Dtype" value={lookup.dtype || "—"} />
              <Field
                label="Quantization"
                value={
                  lookup.quantization_config
                    ? String((lookup.quantization_config as { quant_method?: string }).quant_method || "yes")
                    : "none (bf16)"
                }
              />
              <Field
                label="MoE"
                value={lookup.moe ? `${lookup.moe.num_experts} experts, top_k=${lookup.moe.top_k_experts}` : "dense"}
              />
              <Field label="Weights size" value={gb(lookup.total_bytes)} />
            </div>
          )}

          {err && (
            <p className="mb-3 flex items-center gap-2 font-mono text-[12px] text-coral">
              <TriangleAlert className="h-4 w-4 shrink-0" /> {err}
            </p>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              className="h-[420px] w-full resize-y rounded-md border border-line bg-panel2 p-3 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-cyan/50"
            />
          )}

          <div className="mt-5 flex justify-end gap-3">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button variant="solid" tone="signal" onClick={() => void save()} disabled={saving || loading}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className="truncate font-mono text-[12px] text-ink">{value}</div>
    </div>
  );
}
