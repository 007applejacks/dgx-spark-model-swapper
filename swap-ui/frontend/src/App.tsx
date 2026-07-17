import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Boxes, Wifi, WifiOff, Plus, DownloadCloud, Loader2, ArrowDownUp, Sun, Moon, ScrollText } from "lucide-react";
import { api, type Status, type Model, type DownloadJob, type TestJob } from "./api";
import { GpuBay } from "./components/GpuBay";
import { ModelCard } from "./components/ModelCard";
import { DangerZone } from "./components/DangerZone";
import { UpdatesPanel } from "./components/UpdatesPanel";
import { DiskPanel } from "./components/DiskPanel";
import { UpsPanel } from "./components/UpsPanel";
import { RemoveModelDialog } from "./components/RemoveModelDialog";
import { RecipeEditorDialog } from "./components/RecipeEditorDialog";
import { LogsPanel } from "./components/LogsPanel";
import { ImportDialog } from "./components/ImportDialog";
import { TestPanel } from "./components/TestPanel";
import { ChatPanel } from "./components/ChatPanel";
import { Button, Pill } from "./components/ui";
import { cn } from "./lib/cn";

type SortKey = "status" | "name" | "size" | "downloaded";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "status", label: "Status" },
  { key: "name", label: "Name" },
  { key: "size", label: "Size" },
  { key: "downloaded", label: "On disk" },
];

function sizeGb(m: Model): number {
  const n = parseFloat((m.size.match(/([\d.]+)\s*GB/i) || [])[1] || "0");
  return isNaN(n) ? 0 : n;
}
function sortModels(models: Model[], key: SortKey, currentId: string | null | undefined): Model[] {
  const arr = [...models];
  arr.sort((a, b) => {
    if (key === "name") return a.label.localeCompare(b.label);
    if (key === "size") return sizeGb(b) - sizeGb(a);
    if (key === "downloaded") return Number(b.downloaded) - Number(a.downloaded) || a.label.localeCompare(b.label);
    // status: current first, then downloaded, then non-experimental, then name
    const rank = (m: Model) =>
      (m.id === currentId ? 0 : 1) * 100 + (m.downloaded ? 0 : 10) + (m.experimental ? 5 : 0);
    return rank(a) - rank(b) || a.label.localeCompare(b.label);
  });
  return arr;
}

interface Notice {
  tone: "signal" | "amber" | "coral" | "cyan";
  text: string;
}

function resultNotice(result: string): Notice {
  const [kind, ...rest] = result.split(" ");
  const name = rest.join(" ");
  switch (kind) {
    case "SWAPPED":
      return { tone: "signal", text: `Loaded ${name}` };
    case "NOOP":
      return { tone: "cyan", text: `${name} was already loaded` };
    case "WEDGED":
      return { tone: "coral", text: "GPU wedged — a reboot is required" };
    default:
      return { tone: "coral", text: `Swap failed: ${name || "error"}` };
  }
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [online, setOnline] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const importParam =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("import") : null;
  const [importOpen, setImportOpen] = useState(Boolean(importParam));
  const [download, setDownload] = useState<DownloadJob | null>(null);
  const [testJob, setTestJob] = useState<TestJob | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>("status");
  const [unloading, setUnloading] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Model | null>(null);
  const [editTarget, setEditTarget] = useState<Model | null>(null);
  const [diskRefresh, setDiskRefresh] = useState(0); // bump to make DiskPanel re-fetch its stats
  const [logsOpen, setLogsOpen] = useState(false);
  const prevSwapId = useRef<number>(0);
  const prevDlId = useRef<number>(0);
  const prevTestId = useRef<number>(0);
  const firstTestPoll = useRef<boolean>(true);

  const loadModels = useCallback(async () => {
    try {
      setModels((await api.models()).models);
    } catch {
      /* transient — status poll surfaces connectivity */
    }
  }, []);

  const pollDownload = useCallback(async () => {
    try {
      const d = await api.importStatus();
      setDownload(d.state === "idle" ? null : d);
      if (d.state !== "running" && d.result && d.id !== prevDlId.current && d.id > 0) {
        prevDlId.current = d.id;
        const ok = d.result.startsWith("OK");
        setNotice({ tone: ok ? "signal" : "coral", text: ok ? `Downloaded ${d.repo}` : d.result });
        void loadModels();
      }
    } catch {
      /* handled by status poll */
    }
  }, [loadModels]);

  const pollTest = useCallback(async () => {
    try {
      const t = await api.testStatus();
      if (t.state === "idle") return;
      // On the first poll after a page load, adopt an already-finished result WITHOUT popping the
      // panel open (only show it if a run is actively in progress). Prevents the report reappearing
      // on every refresh; new completions during the session still open it.
      if (firstTestPoll.current) {
        firstTestPoll.current = false;
        prevTestId.current = t.id;
        if (t.state === "running") setTestJob(t);
        return;
      }
      if (t.state === "running") {
        setTestJob(t); // live updates while running
      } else if (t.id !== prevTestId.current && t.id > 0) {
        // just finished: surface it once. Subsequent polls (same id) won't reopen a closed panel.
        prevTestId.current = t.id;
        setTestJob(t);
        const ok = t.report?.summary?.all_passed;
        setNotice({
          tone: ok ? "signal" : "coral",
          text: ok
            ? `${t.served_name} passed all stability tests${t.experimental_cleared ? " — experimental cleared" : ""}`
            : `${t.served_name} failed stability tests`,
        });
        void loadModels();
      }
    } catch {
      /* handled by status poll */
    }
  }, [loadModels]);

  const poll = useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
      setOnline(true);
      // A finished swap job (new id, no longer running) → refresh roster + surface result.
      if (
        s.swap.state !== "running" &&
        s.swap.result &&
        s.swap.id !== prevSwapId.current &&
        s.swap.id > 0
      ) {
        prevSwapId.current = s.swap.id;
        setNotice(resultNotice(s.swap.result));
        void loadModels();
      }
    } catch {
      setOnline(false);
    }
  }, [loadModels]);

  useEffect(() => {
    void loadModels();
    void poll();
    void pollDownload();
    void pollTest();
  }, [loadModels, poll, pollDownload, pollTest]);

  useEffect(() => {
    const fast =
      status?.swap.state === "running" || download?.state === "running" || testJob?.state === "running";
    const id = setInterval(() => {
      void poll();
      void pollDownload();
      void pollTest();
    }, fast ? 1000 : 2500);
    return () => clearInterval(id);
  }, [poll, pollDownload, pollTest, status?.swap.state, download?.state, testJob?.state]);

  const onSwap = useCallback(
    async (model_id: string) => {
      try {
        await api.swap(model_id);
        setNotice(null);
        void poll();
      } catch (e) {
        setNotice({ tone: "coral", text: (e as Error).message });
      }
    },
    [poll],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setModels((await api.refresh()).models);
    } catch (e) {
      setNotice({ tone: "coral", text: (e as Error).message });
    } finally {
      setRefreshing(false);
    }
  }, []);

  const onReboot = useCallback(async () => {
    setRebooting(true);
    setNotice({ tone: "amber", text: "gb10 is rebooting — reconnecting in ~2 min" });
    try {
      await api.reboot();
    } catch {
      /* the box is going down; the request may not return cleanly */
    }
  }, []);

  const onRemoveConfirm = useCallback(
    async (weights: boolean) => {
      if (!removeTarget) return;
      try {
        setModels((await api.deleteModel(removeTarget.id, weights)).models);
        setNotice({ tone: "cyan", text: `Removed ${removeTarget.id}${weights ? " + weights" : ""}` });
        setRemoveTarget(null);
        setDiskRefresh((n) => n + 1); // weights freed / roster changed → refresh disk stats

      } catch (e) {
        setNotice({ tone: "coral", text: (e as Error).message });
      }
    },
    [removeTarget],
  );

  const onPromote = useCallback(
    async (id: string) => {
      try {
        setModels((await api.promoteModel(id)).models);
        setNotice({ tone: "signal", text: `Promoted ${id} — committed to the configs repo` });
      } catch (e) {
        setNotice({ tone: "coral", text: (e as Error).message });
      }
    },
    [],
  );

  const onTest = useCallback(async () => {
    try {
      const res = await api.test();
      setNotice(null);
      setTestJob(res.test); // open the panel immediately
      void pollTest();
    } catch (e) {
      setNotice({ tone: "coral", text: (e as Error).message });
    }
  }, [pollTest]);

  const onCancelSwap = useCallback(async () => {
    try {
      await api.swapCancel();
      setNotice({ tone: "amber", text: "Cancelling load…" });
      void poll();
    } catch (e) {
      setNotice({ tone: "coral", text: (e as Error).message });
    }
  }, [poll]);

  const onUnload = useCallback(async () => {
    setUnloading(true);
    try {
      await api.unload();
      setNotice({ tone: "cyan", text: "Unloaded — GB10 is free" });
      await poll();
    } catch (e) {
      setNotice({ tone: "coral", text: (e as Error).message });
    } finally {
      setUnloading(false);
    }
  }, [poll]);

  const swapping = status?.swap.state === "running";
  const testing = testJob?.state === "running";
  const busy = swapping || rebooting || testing;
  const sortedModels = useMemo(
    () => sortModels(models, sortBy, status?.current.model_id),
    [models, sortBy, status?.current.model_id],
  );

  return (
    <div className="relative z-10 mx-auto min-h-full max-w-6xl overflow-x-hidden px-5 pb-20 pt-6 sm:px-8">
      <Header status={status} online={online} onLogs={() => setLogsOpen(true)} />

      <main className="mt-6 space-y-8">
        {status ? (
          <GpuBay
            status={status}
            models={models}
            onTest={onTest}
            onCancelSwap={onCancelSwap}
            onUnload={onUnload}
            onChat={() => setChatOpen(true)}
            testing={testing}
            unloading={unloading}
          />
        ) : (
          <div className="rounded-xl border border-line bg-panel/60 px-6 py-16 text-center font-mono text-sm text-muted">
            {online ? "Reading bay telemetry…" : "gb10 control plane unreachable — retrying…"}
          </div>
        )}

        <section>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Boxes className="h-4 w-4 text-cyan" />
              <h2 className="font-display text-sm font-semibold uppercase tracking-[0.18em] text-ink">
                Models
              </h2>
              <span className="font-mono text-xs text-muted">
                {models.filter((m) => m.downloaded).length}/{models.length} on disk
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 rounded-md border border-line bg-panel2 px-2.5 py-1.5 font-mono text-[11px] text-muted">
                <ArrowDownUp className="h-3.5 w-3.5" />
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortKey)}
                  className="bg-transparent uppercase tracking-[0.1em] text-ink focus:outline-none"
                  aria-label="Sort models"
                >
                  {SORTS.map((s) => (
                    <option key={s.key} value={s.key} className="bg-panel">
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <Button variant="ghost" onClick={onRefresh} disabled={refreshing}>
                <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
                Refresh
              </Button>
              <Button variant="solid" tone="cyan" onClick={() => setImportOpen(true)}>
                <Plus className="h-3.5 w-3.5" /> Import
              </Button>
            </div>
          </div>

          {download?.state === "running" && (
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-cyan/30 bg-cyan/[0.05] px-4 py-3">
              <DownloadCloud className="h-4 w-4 shrink-0 text-cyan" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12px] text-ink">
                  Downloading <span className="text-cyan">{download.repo}</span>
                </div>
                <div className="truncate font-mono text-[11px] text-muted">
                  {download.progress || "starting…"}
                </div>
              </div>
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-cyan" />
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sortedModels.map((m) => (
              <ModelCard
                key={m.id}
                model={m}
                isCurrent={status?.current.model_id === m.id}
                busy={busy}
                onLoad={() => onSwap(m.id)}
                onPromote={() => onPromote(m.id)}
                onRemove={() => setRemoveTarget(m)}
                onEdit={() => setEditTarget(m)}
              />
            ))}
          </div>
        </section>

        <UpsPanel />

        <DiskPanel refreshSignal={diskRefresh} />

        <UpdatesPanel />

        <DangerZone onReboot={onReboot} rebooting={rebooting} />
      </main>

      {notice && (
        <div className="fixed bottom-5 right-5 z-30 max-w-sm">
          <div
            className={cn(
              "flex items-center gap-3 rounded-lg border bg-panel px-4 py-3 shadow-bay",
              {
                signal: "border-signal/40",
                amber: "border-amber/40",
                coral: "border-coral/40",
                cyan: "border-cyan/40",
              }[notice.tone],
            )}
          >
            <Pill tone={notice.tone} dot>
              {notice.tone === "coral" ? "Alert" : notice.tone === "amber" ? "Notice" : "OK"}
            </Pill>
            <span className="font-mono text-[13px] text-ink">{notice.text}</span>
            <button
              onClick={() => setNotice(null)}
              className="ml-1 font-mono text-lg leading-none text-muted hover:text-ink"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        initialRepo={importParam && importParam !== "1" ? importParam : undefined}
        onCreated={loadModels}
        onDownloadStarted={(repo) => {
          setNotice({ tone: "cyan", text: `Started download of ${repo}` });
          void pollDownload();
        }}
      />
      <TestPanel job={testJob} onClose={() => setTestJob(null)} />
      <ChatPanel
        open={chatOpen}
        model={status?.current.served_name || null}
        onClose={() => setChatOpen(false)}
      />
      <RemoveModelDialog
        model={removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={onRemoveConfirm}
      />
      <RecipeEditorDialog
        model={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={loadModels}
      />
      <LogsPanel open={logsOpen} onClose={() => setLogsOpen(false)} />
    </div>
  );
}

function Header({
  status,
  online,
  onLogs,
}: {
  status: Status | null;
  online: boolean;
  onLogs: () => void;
}) {
  const state = !online
    ? { tone: "coral" as const, label: "Offline", pulse: true }
    : status?.gpu.wedged
      ? { tone: "coral" as const, label: "GPU wedged", pulse: true }
      : status?.swap.state === "running"
        ? { tone: "amber" as const, label: "Swapping", pulse: true }
        : status?.current.healthy
          ? { tone: "signal" as const, label: "Operational", pulse: false }
          : { tone: "cyan" as const, label: "Idle", pulse: false };

  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-5">
      <div className="flex items-baseline gap-3">
        <span className="font-display text-2xl font-bold tracking-tight text-ink">GB10</span>
        <span className="hidden font-mono text-xs uppercase tracking-[0.2em] text-muted sm:inline">
          GB10 · 128&nbsp;GB unified · one bay
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={onLogs}
          title="Logs"
          aria-label="Logs"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line text-muted transition-colors hover:border-cyan/40 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan"
        >
          <ScrollText className="h-4 w-4" />
        </button>
        <ThemeToggle />
        {online ? (
          <Wifi className="h-4 w-4 text-muted" />
        ) : (
          <WifiOff className="h-4 w-4 text-coral" />
        )}
        <Pill tone={state.tone} dot pulse={state.pulse}>
          {state.label}
        </Pill>
      </div>
    </header>
  );
}

function ThemeToggle() {
  const [light, setLight] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("light"),
  );
  const toggle = () => {
    const next = !light;
    setLight(next);
    document.documentElement.classList.toggle("light", next);
    try {
      localStorage.setItem("theme", next ? "light" : "dark");
    } catch {
      /* private mode — theme just won't persist */
    }
  };
  return (
    <button
      onClick={toggle}
      aria-label={light ? "Switch to dark mode" : "Switch to light mode"}
      title={light ? "Dark mode" : "Light mode"}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line text-muted transition-colors hover:border-cyan/40 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan"
    >
      {light ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
    </button>
  );
}
