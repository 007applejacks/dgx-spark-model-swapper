import { useEffect, useState } from "react";
import { BatteryCharging, BatteryWarning, Plug, Clock, Zap, Gauge } from "lucide-react";
import { api, type Ups } from "../api";
import { cn } from "../lib/cn";
import { Panel, Eyebrow, Pill } from "./ui";
import { SegmentMeter } from "./MemoryCore";

function fmtRuntime(min: number | null | undefined): string {
  if (min == null) return "—";
  if (min >= 60) return `${Math.floor(min / 60)}h ${Math.round(min % 60)}m`;
  return `${min.toFixed(0)}m`;
}

function Stat({
  icon: Icon,
  label,
  value,
  unit,
  tone = "ink",
}: {
  icon: typeof Clock;
  label: string;
  value: string;
  unit?: string;
  tone?: "ink" | "signal" | "cyan" | "amber" | "coral";
}) {
  const c = { ink: "text-ink", signal: "text-signal", cyan: "text-cyan", amber: "text-amber", coral: "text-coral" }[tone];
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 eyebrow truncate">
        <Icon className="h-3 w-3 shrink-0" /> {label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className={cn("font-display text-lg font-semibold tabular-nums leading-none", c)}>{value}</span>
        {unit && <span className="truncate font-mono text-[10px] text-muted">{unit}</span>}
      </div>
    </div>
  );
}

// UPS (APC Back-UPS on gb10, read via apcupsd/apcaccess). Self-polls every 10s. Renders nothing
// when there's no UPS/daemon, so the card only appears when there's real data to show.
export function UpsPanel() {
  const [ups, setUps] = useState<Ups | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const u = await api.ups();
        if (!alive) return;
        if (u.available) setUps(u);
        else setGone(true);
      } catch {
        /* backend momentarily unreachable — keep the last reading */
      }
    };
    void load();
    const id = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (gone || !ups) return null;

  const charge = ups.charge_pct ?? null;
  const onBatt = !!ups.on_battery;
  const lowCharge = charge != null && charge < 40;
  const chargeTone: "signal" | "amber" | "coral" = onBatt ? "coral" : lowCharge ? "amber" : "signal";

  return (
    <Panel className="px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {onBatt ? (
            <BatteryWarning className="h-5 w-5 shrink-0 text-coral" />
          ) : (
            <BatteryCharging className="h-5 w-5 shrink-0 text-signal" />
          )}
          <div className="min-w-0">
            <Eyebrow>UPS · battery backup</Eyebrow>
            <div className="mt-0.5 truncate font-mono text-[13px] text-ink">{ups.model || "UPS"}</div>
          </div>
        </div>
        {onBatt ? (
          <Pill tone="coral" dot pulse>
            On battery{ups.time_on_batt_s != null ? ` · ${Math.round(ups.time_on_batt_s)}s` : ""}
          </Pill>
        ) : (
          <Pill tone="signal" dot>
            <Plug className="h-3 w-3" /> On line{ups.line_v != null ? ` · ${ups.line_v.toFixed(0)}V` : ""}
          </Pill>
        )}
      </div>

      <div className="mt-4 space-y-3">
        <SegmentMeter
          label="Battery charge"
          pct={charge}
          tone={chargeTone}
          right={
            <>
              <span className={onBatt ? "text-coral" : "text-signal"}>{charge != null ? charge.toFixed(0) : "—"}</span>
              <span className="text-muted"> %</span>
            </>
          }
        />
        <SegmentMeter
          label="Load"
          pct={ups.load_pct ?? null}
          tone="cyan"
          hotWarn
          right={
            <>
              <span className="text-cyan">{ups.watts ?? "—"}</span>
              <span className="text-muted"> W</span>
            </>
          }
        />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-4">
        <Stat icon={Clock} label="Runtime" value={fmtRuntime(ups.timeleft_min)} tone={onBatt ? "coral" : "ink"} />
        <Stat icon={Gauge} label="Load" value={ups.load_pct != null ? ups.load_pct.toFixed(0) : "—"} unit="%" />
        <Stat icon={Zap} label="Input" value={ups.line_v != null ? ups.line_v.toFixed(0) : "—"} unit="V" tone={onBatt ? "coral" : "ink"} />
      </div>
    </Panel>
  );
}
