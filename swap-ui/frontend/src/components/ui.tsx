import { cn } from "../lib/cn";

export function Panel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "relative rounded-xl border border-line bg-panel/80 backdrop-blur-sm",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("eyebrow", className)}>{children}</div>;
}

type Tone = "signal" | "amber" | "coral" | "cyan" | "muted";

const toneMap: Record<Tone, string> = {
  signal: "text-signal border-signal/40 bg-signal/10",
  amber: "text-amber border-amber/40 bg-amber/10",
  coral: "text-coral border-coral/40 bg-coral/10",
  cyan: "text-cyan border-cyan/40 bg-cyan/10",
  muted: "text-muted border-line bg-[var(--fill-empty)]",
};

export function Pill({
  tone = "muted",
  dot,
  pulse,
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.14em]",
        toneMap[tone],
        className,
      )}
    >
      {dot && (
        <span
          className={cn("h-1.5 w-1.5 rounded-full bg-current", pulse && "animate-pulseStage")}
        />
      )}
      {children}
    </span>
  );
}

export function Button({
  variant = "solid",
  tone = "cyan",
  className,
  ...props
}: {
  variant?: "solid" | "ghost" | "danger";
  tone?: "cyan" | "signal" | "coral";
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 font-mono text-[12px] font-medium uppercase tracking-[0.12em] transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
  const variants: Record<string, string> = {
    solid: {
      cyan: "bg-cyan/15 text-cyan border border-cyan/40 hover:bg-cyan/25 focus-visible:ring-cyan",
      signal:
        "bg-signal/15 text-signal border border-signal/40 hover:bg-signal/25 focus-visible:ring-signal",
      coral:
        "bg-coral/15 text-coral border border-coral/40 hover:bg-coral/25 focus-visible:ring-coral",
    }[tone]!,
    ghost:
      "border border-line text-muted hover:text-ink hover:border-cyan/40 focus-visible:ring-cyan",
    danger:
      "bg-coral/10 text-coral border border-coral/50 hover:bg-coral hover:text-bg focus-visible:ring-coral",
  };
  return <button className={cn(base, variants[variant], className)} {...props} />;
}
