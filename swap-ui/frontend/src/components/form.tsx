import { cn } from "../lib/cn";

// Compact shadcn-style form primitives for the import dialog.

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block font-mono text-[10px] text-muted/70">{hint}</span>}
    </label>
  );
}

const control =
  "w-full rounded-md border border-line bg-panel2 px-3 py-2 font-mono text-[13px] text-ink " +
  "placeholder:text-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/60 " +
  "focus-visible:border-cyan/60 transition-colors";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(control, props.className)} />;
}

export function Select({
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cn(control, "appearance-none pr-8", props.className)}>
      {children}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex items-center gap-2 rounded-md border px-3 py-2 font-mono text-[12px] transition-colors",
        checked ? "border-cyan/50 bg-cyan/10 text-cyan" : "border-line bg-panel2 text-muted",
      )}
    >
      <span
        className={cn(
          "relative h-4 w-7 rounded-full transition-colors",
          checked ? "bg-cyan/70" : "bg-[var(--fill-empty)]",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-3 w-3 rounded-full bg-bg transition-all",
            checked ? "left-3.5" : "left-0.5",
          )}
        />
      </span>
      {label}
    </button>
  );
}
