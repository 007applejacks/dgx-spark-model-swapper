import { useCallback, useEffect, useRef, useState } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import {
  PackageCheck, RefreshCw, Download, Ban, Loader2, CheckCircle2, ChevronDown, KeyRound, TriangleAlert, Search,
} from "lucide-react";
import { api, type UpdatesInfo, type UpdateJob } from "../api";
import { cn } from "../lib/cn";
import { Button, Eyebrow, Pill } from "./ui";

export function UpdatesPanel() {
  const [info, setInfo] = useState<UpdatesInfo | null>(null);
  const [job, setJob] = useState<UpdateJob | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // The server remembers the last apt job forever, so only render a job this session owns: one we
  // launched, or one we picked up mid-flight. An install that finished before this page loaded is
  // history — showing its "Updates installed." next to a later count reads as a failed install.
  const ownedJob = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const u = await api.updates();
      setInfo(u);
      if (u.job.state === "running") ownedJob.current = u.job.id; // adopt an in-flight install
      setJob(ownedJob.current === u.job.id ? u.job : null);
    } catch {
      /* host may be rebooting */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (job?.state !== "running") return;
    const id = setInterval(async () => {
      try {
        const j = await api.updatesJob();
        setJob(j);
        if (j.state !== "running") void load(); // install finished → refresh the count (clears it)
      } catch {
        /* ignore */
      }
    }, 1500);
    return () => clearInterval(id);
  }, [job?.state, load]);

  const running = job?.state === "running";
  const count = info?.count ?? 0;

  async function check() {
    setChecking(true);
    setErr(null);
    await load();
    setTimeout(() => setChecking(false), 400); // brief visible "checking" even on a fast re-scan
  }

  async function install() {
    if (!pw) return;
    setSubmitting(true);
    setErr(null);
    try {
      const { job: j } = await api.updatesInstall(pw);
      ownedJob.current = j.id;
      setJob(j);
      setInstallOpen(false);
      setPw("");
    } catch (e) {
      setErr(`install: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-xl border border-line bg-panel/70 px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <PackageCheck className="h-5 w-5 shrink-0 text-cyan" />
          <div className="min-w-0">
            <Eyebrow>System updates</Eyebrow>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[13px]">
              {checking ? (
                <span className="inline-flex items-center gap-1.5 text-cyan">
                  <Search className="h-4 w-4 animate-pulse" /> checking…
                </span>
              ) : count > 0 ? (
                <>
                  <span className="font-display text-lg font-bold text-amber">{count}</span>
                  <span className="text-muted">available</span>
                  {info?.security ? <Pill tone="coral">{info.security} security</Pill> : null}
                </>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-signal">
                  <CheckCircle2 className="h-4 w-4" /> up to date
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button variant="danger" onClick={() => void api.updatesCancel()}>
              <Ban className="h-3.5 w-3.5" /> Cancel
            </Button>
          ) : (
            <>
              <Button
                variant={checking ? "solid" : "ghost"}
                tone="cyan"
                onClick={() => void check()}
                disabled={checking}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", checking && "animate-spin")} />{" "}
                {checking ? "Checking…" : "Check"}
              </Button>
              {count > 0 && (
                <Button variant="solid" tone="cyan" onClick={() => setInstallOpen(true)}>
                  <Download className="h-3.5 w-3.5" /> Install
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {err && <p className="mt-3 font-mono text-[12px] text-coral">{err}</p>}

      {/* live install feedback (searching → installing, from the apt log) */}
      {job && (job.state === "running" || job.result) && (
        <div className="mt-4 rounded-md border border-line bg-panel2 p-3">
          <div className="mb-1.5 font-mono text-[12px]">
            {job.state === "running" ? (
              <span className="inline-flex items-center gap-2 text-amber">
                <Loader2 className="h-4 w-4 animate-spin" /> Installing updates…
              </span>
            ) : (
              <span className={job.result?.startsWith("OK") ? "text-signal" : "text-coral"}>
                {job.result?.startsWith("OK") ? "Updates installed." : job.result}
              </span>
            )}
          </div>
          {job.log_tail.length > 0 && (
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-muted">
              {job.log_tail.join("\n")}
            </pre>
          )}
        </div>
      )}

      {count > 0 && !running && (
        <div className="mt-4">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted hover:text-ink"
          >
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
            {expanded ? "Hide" : "Show"} {count} package(s)
          </button>
          {expanded && (
            <div className="mt-2 max-h-56 space-y-1 overflow-auto rounded-md border border-line bg-panel2 p-3">
              {info?.packages.map((p) => (
                <div key={p.name} className="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px]">
                  <span className="text-ink">{p.name}</span>
                  <span className="text-muted">{p.old}</span>
                  <span className="text-line">→</span>
                  <span className="text-signal/80">{p.new}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* install needs the sudo password (check does not) */}
      <AlertDialog.Root open={installOpen} onOpenChange={(v) => !v && (setInstallOpen(false), setPw(""))}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-amber/40 bg-panel p-6 shadow-bay">
            <AlertDialog.Title className="font-display text-xl font-bold text-ink">
              Install {count} update(s)?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 font-mono text-[13px] leading-relaxed text-muted">
              Runs <span className="text-ink">apt-get update &amp;&amp; apt-get upgrade</span> on gb10. This can
              pull NVIDIA / kernel / docker updates that may disrupt the serving model or need a reboot.
            </AlertDialog.Description>
            <p className="mt-3 flex items-center gap-2 font-mono text-[11px] text-amber">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" /> Consider unloading the model first.
            </p>

            <label className="mt-4 block">
              <span className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
                <KeyRound className="h-3 w-3" /> sudo password (nathan)
              </span>
              <input
                type="password"
                autoFocus
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && pw && void install()}
                className="w-full rounded-md border border-line bg-panel2 px-3 py-2 font-mono text-[13px] text-ink focus-visible:border-cyan/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/50"
              />
            </label>
            <p className="mt-1.5 font-mono text-[10px] text-muted">
              Sent once over this connection, piped to sudo, never stored. Use the tailnet HTTPS URL, not plain LAN HTTP.
            </p>

            <div className="mt-5 flex justify-end gap-3">
              <AlertDialog.Cancel asChild>
                <Button variant="ghost">Cancel</Button>
              </AlertDialog.Cancel>
              <Button variant="solid" tone="cyan" disabled={!pw || submitting} onClick={() => void install()}>
                {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Install now
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}
