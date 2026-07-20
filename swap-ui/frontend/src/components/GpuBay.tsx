import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Cpu, Thermometer, Server, FlaskConical, Ban, PowerOff, MessagesSquare, Copy, Check, Radio, Timer, Gauge, TriangleAlert } from "lucide-react";
import type { Status, Model } from "../api";
import { cn } from "../lib/cn";
import { Panel, Eyebrow, Pill, Button } from "./ui";
import { MemoryCore, UtilMeter } from "./MemoryCore";
import { SwapSequence } from "./SwapSequence";

function fmtUptime(s: number | null): string {
  if (s == null) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function fmt(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K";
  return String(n);
}

function Stat({ label, value, unit, tone = "ink" }: { label: string; value: string; unit: string; tone?: string }) {
  const c = { ink: "text-ink", signal: "text-signal", cyan: "text-cyan", muted: "text-muted", amber: "text-amber" }[tone] || "text-ink";
  return (
    <div className="min-w-0">
      <div className="eyebrow truncate">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className={cn("font-display text-lg font-semibold tabular-nums leading-none", c)}>{value}</span>
        <span className="truncate font-mono text-[10px] text-muted">{unit}</span>
      </div>
    </div>
  );
}

// Stable client endpoint: the transparent proxy that retargets any model name to whatever's loaded.
// Uses the origin the dashboard was reached on, so the copied URL is actually reachable.
function ClientEndpoint() {
  const url = typeof window !== "undefined" ? `${window.location.origin}/proxy/v1` : "/proxy/v1";
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div className="rounded-md border border-line bg-panel2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Radio className="h-3.5 w-3.5 shrink-0 text-cyan" />
          <div className="min-w-0">
            <div className="eyebrow">Client endpoint</div>
            <div className="mt-0.5 truncate font-mono text-[12px] text-cyan">{url}</div>
          </div>
        </div>
        <button
          onClick={copy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded border border-line px-2 py-1 font-mono text-[10px] text-muted hover:text-ink"
        >
          {copied ? <Check className="h-3 w-3 text-signal" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="mt-1.5 font-mono text-[10px] leading-relaxed text-muted">
        Point clients here — any model name routes to whatever's loaded, so they never break on a swap.
      </div>
    </div>
  );
}

// NVIDIA brand green — labels the actual GB10 hardware (nominative brand use).
function NvidiaTag() {
  return (
    <span
      className="font-display text-[13px] font-bold tracking-tight"
      style={{ color: "#76B900" }}
    >
      NVIDIA
    </span>
  );
}

function Readout({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted">{icon}</span>
      <div className="leading-tight">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">{label}</div>
        <div className="font-mono text-sm text-ink tabular-nums">{value}</div>
      </div>
    </div>
  );
}

export function GpuBay({
  status,
  models,
  onTest,
  onCancelSwap,
  onUnload,
  onChat,
  onThroughputBenchmark,
  testing,
  unloading,
  throughputBenchmarking,
}: {
  status: Status;
  models: Model[];
  onTest: () => void;
  onCancelSwap: () => void;
  onUnload: () => void;
  onChat: () => void;
  onThroughputBenchmark: () => void;
  testing: boolean;
  unloading: boolean;
  throughputBenchmarking: boolean;
}) {
  const { gpu, current, swap, serve_port, connections, throughput } = status;
  const swapping = swap.state === "running";
  const occupant = models.find((m) => m.id === current.model_id);
  const [confirmThroughputOpen, setConfirmThroughputOpen] = useState(false);

  const coreState = gpu.wedged
    ? "wedged"
    : swapping
      ? "swapping"
      : current.healthy
        ? "healthy"
        : "idle";

  const targetLabel =
    (swap.model_id && models.find((m) => m.id === swap.model_id)?.label) || swap.model_id || "—";

  return (
    <>
    <Panel className="overflow-hidden shadow-bay">
      {/* top rail: bay identity + live GPU telemetry (stacks on mobile) */}
      <div className="flex flex-col gap-3 border-b border-line px-6 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Cpu className="h-5 w-5 shrink-0 text-cyan" />
          <div className="min-w-0">
            <Eyebrow>GPU Bay · single occupant</Eyebrow>
            <div className="mt-0.5 flex items-center gap-2 font-display text-sm text-muted">
              <NvidiaTag />
              <span>{(gpu.name || "GB10").replace(/^NVIDIA\s*/i, "")}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Readout
            icon={<Thermometer className="h-4 w-4" />}
            label="Temp"
            value={gpu.temp_c != null ? `${gpu.temp_c}°C` : "—"}
          />
          <Readout
            icon={<Timer className="h-4 w-4" />}
            label="Uptime"
            value={current.loaded ? fmtUptime(current.uptime_s) : "—"}
          />
          <Readout
            icon={<Server className="h-4 w-4" />}
            label="Endpoint"
            value={`:${serve_port}`}
          />
        </div>
      </div>

      {/* main stage: occupant, or the swap airlock while transitioning */}
      <div className="space-y-6 px-6 py-6">
        {swapping ? (
          <div className="space-y-4">
            <SwapSequence phase={swap.phase} wedged={gpu.wedged} targetLabel={targetLabel} progress={swap.progress} />
            <div className="flex justify-end">
              <Button variant="danger" onClick={onCancelSwap}>
                <Ban className="h-3.5 w-3.5" /> Cancel load
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
            <div className="min-w-0">
              <Eyebrow className={current.loaded ? "text-signal" : "text-muted"}>
                {current.loaded ? "Loaded" : "Bay empty"}
              </Eyebrow>
              <h2 className="mt-1 break-words font-display text-xl font-bold text-ink sm:text-3xl">
                {occupant?.label || current.served_name || "No model loaded"}
              </h2>
              {current.served_name && (
                <p className="mt-1 font-mono text-xs text-muted">
                  served as <span className="text-cyan">{current.served_name}</span>
                  {occupant?.size ? ` · ${occupant.size}` : ""}
                </p>
              )}
            </div>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:gap-3">
              <div className="w-full sm:w-auto">
                {gpu.wedged ? (
                  <Pill tone="coral" dot pulse>
                    GPU wedged
                  </Pill>
                ) : current.healthy ? (
                  <Pill tone="signal" dot>
                    Healthy
                  </Pill>
                ) : current.loaded ? (
                  <Pill tone="amber" dot pulse>
                    Starting
                  </Pill>
                ) : (
                  <Pill tone="muted">Idle</Pill>
                )}
              </div>
              {current.loaded && !gpu.wedged && (
                <Button
                  variant="ghost"
                  onClick={onUnload}
                  disabled={unloading || testing}
                  className="w-full sm:w-auto"
                >
                  <PowerOff className="h-3.5 w-3.5" /> {unloading ? "Unloading…" : "Unload"}
                </Button>
              )}
              {current.healthy && !gpu.wedged && (
                <Button variant="ghost" onClick={onChat} className="w-full sm:w-auto">
                  <MessagesSquare className="h-3.5 w-3.5" /> Chat
                </Button>
              )}
              {current.healthy && !gpu.wedged && (
                <Button
                  variant="solid"
                  tone="cyan"
                  onClick={onTest}
                  disabled={testing}
                  className="w-full sm:w-auto"
                >
                  <FlaskConical className="h-3.5 w-3.5" /> {testing ? "Testing…" : "Test stability"}
                </Button>
              )}
              {current.healthy && !gpu.wedged && (
                <Button
                  variant="ghost"
                  onClick={() => setConfirmThroughputOpen(true)}
                  disabled={throughputBenchmarking || testing}
                  className="w-full sm:w-auto"
                >
                  <Gauge className="h-3.5 w-3.5" />
                  {throughputBenchmarking ? "Benchmarking…" : "Benchmark throughput"}
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="space-y-4">
          <MemoryCore usedMb={gpu.mem_used_mb} totalMb={gpu.mem_total_mb} state={coreState} />
          <UtilMeter util={gpu.util_pct} wedged={gpu.wedged} />
          {/* live throughput + activity summary */}
          <div className="rounded-md border border-line bg-panel2 px-3 py-2.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="eyebrow">Activity</span>
              <span className="font-mono text-[10px] text-muted">since load</span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Stat
                label="Throughput"
                value={throughput?.gen_tok_s != null ? String(throughput.gen_tok_s) : "0"}
                unit="tok/s"
                tone={throughput?.gen_tok_s ? "signal" : "muted"}
              />
              <Stat
                label="In flight"
                value={String(connections?.running ?? 0)}
                unit={connections?.waiting ? `+${connections.waiting} queued` : "active"}
                tone={connections?.running ? "cyan" : "muted"}
              />
              <Stat label="Requests" value={fmt(throughput?.total_requests ?? 0)} unit="served" />
            </div>
            <div className="mt-2 font-mono text-[10px] text-muted">
              {throughput
                ? `${fmt(throughput.total_gen_tokens)} generated · ${fmt(throughput.total_prompt_tokens)} prompt tokens`
                : "no metrics"}
            </div>
          </div>
          <ClientEndpoint />
        </div>

        {gpu.wedged && (
          <p className="font-mono text-xs text-coral">
            The integrated GPU did not release — it can only be recovered by a reboot. Use Reboot gb10
            below, then reload a model.
          </p>
        )}
      </div>
    </Panel>

    <Dialog.Root open={confirmThroughputOpen} onOpenChange={setConfirmThroughputOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(94vw,440px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-panel p-6 shadow-bay">
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber" />
            <div>
              <Dialog.Title className="font-display text-lg font-bold text-ink">
                This takes the model offline
              </Dialog.Title>
              <Dialog.Description className="mt-2 font-mono text-[12px] leading-relaxed text-muted">
                vLLM's offline throughput benchmark always loads its own standalone model
                instance — it can't run alongside the one currently serving. This will unload{" "}
                <span className="text-ink">{occupant?.label || current.served_name}</span>,
                benchmark a temporary instance, then reload it. Expect several minutes of
                downtime on <span className="text-ink">:{serve_port}</span>.
              </Dialog.Description>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2.5">
            <Button variant="ghost" onClick={() => setConfirmThroughputOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmThroughputOpen(false);
                onThroughputBenchmark();
              }}
            >
              <Gauge className="h-3.5 w-3.5" /> Take offline &amp; benchmark
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    </>
  );
}
