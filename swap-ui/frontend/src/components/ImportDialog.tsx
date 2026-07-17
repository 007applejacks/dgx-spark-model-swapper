import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { DownloadCloud, Search, TriangleAlert, X, KeyRound } from "lucide-react";
import { api, type Recipe } from "../api";
import { Button, Eyebrow } from "./ui";
import { Field, Input, Select, Toggle } from "./form";

export function ImportDialog({
  open,
  onOpenChange,
  onCreated,
  onDownloadStarted,
  initialRepo,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
  onDownloadStarted: (repo: string) => void;
  initialRepo?: string;
}) {
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [tokenPresent, setTokenPresent] = useState(true);

  function reset() {
    setRepo("");
    setRecipe(null);
    setErr(null);
    setBusy(false);
  }

  async function inspectRepo(target: string) {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.importInspect(target.trim());
      setRecipe(r.recipe);
      setTokenPresent(r.token_present);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const inspect = () => inspectRepo(repo);

  // Deep-link: /?import=<repo> opens the dialog pre-filled and auto-inspects once.
  useEffect(() => {
    if (open && initialRepo && !repo && !recipe) {
      setRepo(initialRepo);
      void inspectRepo(initialRepo);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialRepo]);

  async function add(download: boolean) {
    if (!recipe) return;
    setBusy(true);
    setErr(null);
    try {
      await api.createModel(recipe);
      onCreated();
      if (download) {
        await api.importDownload(recipe.repo);
        onDownloadStarted(recipe.repo);
      }
      onOpenChange(false);
      reset();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const set = <K extends keyof Recipe>(k: K, v: Recipe[K]) =>
    setRecipe((r) => (r ? { ...r, [k]: v } : r));

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(94vw,640px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-panel p-6 shadow-bay">
          <div className="mb-5 flex items-start justify-between">
            <div>
              <Eyebrow className="text-cyan">Import from HuggingFace</Eyebrow>
              <Dialog.Title className="mt-1 font-display text-xl font-bold text-ink">
                Add a model
              </Dialog.Title>
            </div>
            <Dialog.Close className="text-muted hover:text-ink" aria-label="Close">
              <X className="h-5 w-5" />
            </Dialog.Close>
          </div>

          {/* repo input + inspect */}
          <div className="flex items-end gap-2">
            <Field label="HF repo id" className="flex-1">
              <Input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="owner/Model-Name-NVFP4"
                spellCheck={false}
                onKeyDown={(e) => e.key === "Enter" && repo.trim() && inspect()}
              />
            </Field>
            <Button variant="solid" tone="cyan" onClick={inspect} disabled={busy || !repo.trim()}>
              <Search className="h-3.5 w-3.5" /> Inspect
            </Button>
          </div>

          {!tokenPresent && (
            <p className="mt-3 flex items-center gap-2 font-mono text-[11px] text-amber">
              <KeyRound className="h-3.5 w-3.5" /> No HF token on gb10 — gated repos and full-speed
              pulls need one (see README).
            </p>
          )}

          {err && (
            <p className="mt-3 flex items-center gap-2 font-mono text-[12px] text-coral">
              <TriangleAlert className="h-4 w-4 shrink-0" /> {err}
            </p>
          )}

          {/* editable recipe */}
          {recipe && (
            <div className="mt-6 space-y-4 border-t border-line pt-5">
              <Eyebrow>Recipe — auto-detected, edit before saving</Eyebrow>

              {recipe.warnings && recipe.warnings.length > 0 && (
                <ul className="space-y-1 rounded-md border border-amber/30 bg-amber/[0.06] p-3">
                  {recipe.warnings.map((w, i) => (
                    <li key={i} className="flex items-start gap-2 font-mono text-[11px] text-amber">
                      <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" /> {w}
                    </li>
                  ))}
                </ul>
              )}

              <div className="grid grid-cols-2 gap-4">
                <Field label="Model id" hint="lowercase slug; must be unique">
                  <Input value={recipe.id} onChange={(e) => set("id", e.target.value)} spellCheck={false} />
                </Field>
                <Field label="Display label">
                  <Input value={recipe.label} onChange={(e) => set("label", e.target.value)} />
                </Field>
                <Field label="Reasoning parser" hint="thinking-model output splitter">
                  <Select
                    value={recipe.reasoning_parser}
                    onChange={(e) => set("reasoning_parser", e.target.value)}
                  >
                    <option value="qwen3">qwen3</option>
                    <option value="nemotron_v3">nemotron_v3</option>
                    <option value="">(none)</option>
                  </Select>
                </Field>
                <Field label="Quantization">
                  <Select value={recipe.quant} onChange={(e) => set("quant", e.target.value)}>
                    <option value="auto">auto</option>
                    <option value="modelopt">modelopt (NVFP4)</option>
                    <option value="fp8">fp8</option>
                    <option value="awq">awq</option>
                  </Select>
                </Field>
                <Field label="Max context">
                  <Input
                    type="number"
                    value={recipe.max_len}
                    onChange={(e) => set("max_len", Number(e.target.value))}
                  />
                </Field>
                <Field label="Extra vLLM args" hint="e.g. --max-num-seqs 4">
                  <Input value={recipe.extra_args} onChange={(e) => set("extra_args", e.target.value)} />
                </Field>
              </div>

              <div className="flex flex-wrap gap-3">
                <Toggle checked={recipe.tools} onChange={(v) => set("tools", v)} label="Tool-calling" />
                <Toggle
                  checked={recipe.spec_decode}
                  onChange={(v) => set("spec_decode", v)}
                  label="Spec decode (MTP)"
                />
                <Toggle
                  checked={recipe.experimental}
                  onChange={(v) => set("experimental", v)}
                  label="Experimental"
                />
              </div>

              <p className="font-mono text-[11px] leading-relaxed text-muted">
                Saved to gb10's local registry (<span className="text-cyan">models.d/</span>). Serving
                tuning is pinned off — validate before relying on it. Export later to version it in the repo.
              </p>

              <div className="flex justify-end gap-3 pt-1">
                <Button variant="ghost" onClick={() => add(false)} disabled={busy}>
                  Add only
                </Button>
                <Button variant="solid" tone="signal" onClick={() => add(true)} disabled={busy}>
                  <DownloadCloud className="h-3.5 w-3.5" /> Add &amp; download
                </Button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
