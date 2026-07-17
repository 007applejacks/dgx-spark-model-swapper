import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Send, Loader2, Trash2, Brain, MessagesSquare, ChevronDown, Square } from "lucide-react";
import { cn } from "../lib/cn";
import { Button, Eyebrow } from "./ui";
import { Markdown } from "./Markdown";

interface Msg {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
}

export function ChatPanel({
  open,
  model,
  onClose,
}: {
  open: boolean;
  model: string | null;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showReasoning, setShowReasoning] = useState<Set<number>>(new Set());

  function toggleReasoning(i: number) {
    setShowReasoning((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // On mobile the keyboard doesn't shrink 100dvh, so a bottom-anchored input hides behind
  // it. Track the visual viewport and pin the dialog to the actually-visible region.
  const [vv, setVv] = useState<{ h: number; top: number } | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  useEffect(() => {
    const vvp = window.visualViewport;
    if (!open || !vvp) return;
    const update = () => setVv({ h: vvp.height, top: vvp.offsetTop });
    update();
    vvp.addEventListener("resize", update);
    vvp.addEventListener("scroll", update);
    return () => {
      vvp.removeEventListener("resize", update);
      vvp.removeEventListener("scroll", update);
      setVv(null);
    };
  }, [open]);

  const isMobile = typeof window !== "undefined" && window.innerWidth < 640;
  const vvStyle = vv && isMobile ? { height: `${vv.h}px`, top: `${vv.top}px`, bottom: "auto" } : undefined;

  function reset() {
    abortRef.current?.abort();
    setMessages([]);
    setInput("");
    setErr(null);
    setStreaming(false);
    setShowReasoning(new Set());
  }

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setErr(null);
    const history: Msg[] = [...messages, { role: "user", content: text }];
    setMessages([...history, { role: "assistant", content: "", reasoning: "" }]);
    setInput("");
    setStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      // Chat runs on the unprivileged gx10-agent daemon, reached same-origin via the tailnet path
      // mount (/agent → 127.0.0.1:8090). The privileged :8080 (nathan) app is not on this path.
      const res = await fetch("/agent/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history.map((m) => ({ role: m.role, content: m.content })) }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`chat failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let content = "";
      let reasoning = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const l = line.trim();
          if (!l.startsWith("data:")) continue;
          const data = l.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            if (json.error) throw new Error(json.error);
            const delta = json.choices?.[0]?.delta || {};
            if (delta.reasoning || delta.reasoning_content) reasoning += delta.reasoning || delta.reasoning_content;
            if (delta.content) content += delta.content;
            setMessages((prev) => {
              const next = [...prev];
              next[next.length - 1] = { role: "assistant", content, reasoning };
              return next;
            });
          } catch (e) {
            if ((e as Error).message && !(e instanceof SyntaxError)) throw e;
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setErr((e as Error).message);
    } finally {
      setStreaming(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          abortRef.current?.abort();
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          style={vvStyle}
          className="fixed inset-0 z-50 flex h-[100dvh] w-full flex-col overflow-hidden border-line bg-panel shadow-bay sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-[85vh] sm:max-h-[85vh] sm:w-[min(94vw,720px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border"
        >
          <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <Eyebrow className="text-cyan">Chat · loaded model</Eyebrow>
              <Dialog.Title className="mt-1 flex items-center gap-2 font-display text-lg font-bold text-ink">
                <MessagesSquare className="h-4 w-4 shrink-0 text-cyan" />
                <span className="truncate">{model || "model"}</span>
              </Dialog.Title>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <button
                onClick={reset}
                disabled={streaming && messages.length === 0}
                className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted hover:text-ink"
              >
                <Trash2 className="h-3.5 w-3.5" /> Clear
              </button>
              <Dialog.Close className="text-muted hover:text-ink" aria-label="Close">
                <X className="h-5 w-5" />
              </Dialog.Close>
            </div>
          </div>

          {/* messages */}
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-5">
            {messages.length === 0 && (
              <div className="flex h-full items-center justify-center text-center font-mono text-[13px] text-muted">
                Send a message to chat with {model}.
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "min-w-0 max-w-[85%] rounded-lg px-3.5 py-2.5 font-mono text-[13px] leading-relaxed",
                    m.role === "user"
                      ? "border border-cyan/30 bg-cyan/[0.08] text-ink"
                      : "border border-line bg-panel2 text-ink",
                  )}
                >
                  {m.reasoning?.trim() && (
                    <div className="mb-2 border-b border-line pb-2">
                      <button
                        onClick={() => toggleReasoning(i)}
                        className="flex select-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted transition-colors hover:text-ink"
                      >
                        <Brain className="h-3 w-3" /> reasoning
                        <ChevronDown
                          className={cn("h-3 w-3 transition-transform", showReasoning.has(i) && "rotate-180")}
                        />
                      </button>
                      {showReasoning.has(i) && (
                        <div className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-line pl-2.5 text-[11px] italic text-muted">
                          {m.reasoning}
                        </div>
                      )}
                    </div>
                  )}
                  {m.role === "assistant" ? (
                    m.content.trim() ? (
                      <Markdown>{m.content.trimStart()}</Markdown>
                    ) : streaming && i === messages.length - 1 ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted" />
                    ) : null
                  ) : (
                    <div className="whitespace-pre-wrap break-words">{m.content}</div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {err && <div className="border-t border-coral/30 bg-coral/[0.05] px-5 py-2 font-mono text-[12px] text-coral">{err}</div>}

          {/* input */}
          <div className="flex items-end gap-2 border-t border-line px-4 py-3 sm:px-5 sm:py-4">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              placeholder="Message…"
              className="max-h-32 min-h-[42px] min-w-0 flex-1 resize-none rounded-md border border-line bg-panel2 px-3 py-2.5 font-mono text-[16px] text-ink placeholder:text-muted/50 focus-visible:border-cyan/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/50 sm:text-[13px]"
            />
            {streaming ? (
              <Button variant="danger" className="shrink-0" onClick={() => abortRef.current?.abort()}>
                <Square className="h-3.5 w-3.5" /> Stop
              </Button>
            ) : (
              <Button variant="solid" tone="cyan" className="shrink-0" onClick={() => void send()} disabled={!input.trim()}>
                <Send className="h-3.5 w-3.5" /> Send
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
