import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, ScrollText, Loader2, Pause, Play } from "lucide-react";
import { api } from "../api";
import { cn } from "../lib/cn";
import { Eyebrow } from "./ui";

type Source = "model" | "service";
const SOURCES: { key: Source; label: string }[] = [
  { key: "model", label: "Model (vLLM)" },
  { key: "service", label: "Swap-UI service" },
];

export function LogsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [source, setSource] = useState<Source>("model");
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [paused, setPaused] = useState(false);
  const scrollRef = useRef<HTMLPreElement>(null);
  const atBottomRef = useRef(true);

  const fetchLogs = useCallback(async (src: Source) => {
    setLoading(true);
    try {
      const r = await api.logs(src);
      setLabel(r.label);
      setText(r.text);
    } catch (e) {
      setText(`error: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // fetch on open + source change
  useEffect(() => {
    if (open) void fetchLogs(source);
  }, [open, source, fetchLogs]);

  // poll while open + not paused
  useEffect(() => {
    if (!open || paused) return;
    const id = setInterval(() => void fetchLogs(source), 2500);
    return () => clearInterval(id);
  }, [open, paused, source, fetchLogs]);

  // auto-scroll to bottom on update if the user was already near the bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[85vh] max-h-[85vh] w-[min(94vw,860px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-line bg-panel shadow-bay">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <Eyebrow className="text-cyan">Logs</Eyebrow>
              <Dialog.Title className="mt-1 flex items-center gap-2 font-display text-lg font-bold text-ink">
                <ScrollText className="h-4 w-4 text-cyan" />
                <span className="truncate">{label || "logs"}</span>
              </Dialog.Title>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex rounded-md border border-line p-0.5">
                {SOURCES.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => setSource(s.key)}
                    className={cn(
                      "rounded px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors",
                      source === s.key ? "bg-cyan/15 text-cyan" : "text-muted hover:text-ink",
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setPaused((p) => !p)}
                title={paused ? "Resume" : "Pause"}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line text-muted hover:text-ink"
              >
                {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              </button>
              {loading && <Loader2 className="h-4 w-4 animate-spin text-muted" />}
              <Dialog.Close className="text-muted hover:text-ink" aria-label="Close">
                <X className="h-5 w-5" />
              </Dialog.Close>
            </div>
          </div>

          <pre
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
            className="flex-1 overflow-auto whitespace-pre-wrap break-words bg-panel2/50 px-5 py-4 font-mono text-[11px] leading-relaxed text-muted"
          >
            {text || "—"}
          </pre>

          <div className="border-t border-line px-5 py-2 font-mono text-[10px] text-muted">
            {paused ? "paused" : "live · refreshing every 2.5s"} · tailing last 400 lines
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
