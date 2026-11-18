import { useEffect, useId, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export { cx };

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: LucideIcon;
  size?: "sm" | "md";
};

export function Button({ variant = "secondary", icon: Icon, size = "md", className, children, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors",
        "disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-accent",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3.5 text-[13px]",
        variant === "primary" && "bg-accent text-on-accent font-semibold hover:brightness-110",
        variant === "secondary" && "bg-surface-2 border border-line text-fg hover:bg-surface-3",
        variant === "ghost" && "text-fg-2 hover:bg-surface-2 hover:text-fg",
        variant === "danger" && "bg-bad/10 border border-bad/30 text-bad hover:bg-bad/20",
        className,
      )}
    >
      {Icon && <Icon size={size === "sm" ? 14 : 16} className={variant === "secondary" ? "text-fg-2" : undefined} />}
      {children}
    </button>
  );
}

export function IconButton({ icon: Icon, label, active, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; active?: boolean }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors",
        active ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-2 hover:text-fg",
        "disabled:opacity-40 disabled:pointer-events-none",
        className,
      )}
    >
      <Icon size={16} />
    </button>
  );
}

/** Numeric input that commits on blur / Enter so typing "1." is not reformatted. */
export function NumberField({
  label,
  value,
  onChange,
  unit,
  step = 0.1,
  min,
  max,
  className,
  placeholder,
}: {
  label?: string;
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
  className?: string;
  placeholder?: string;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const v = parseFloat(text.replace(",", "."));
    if (Number.isFinite(v)) {
      const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
      onChange(c);
      setText(String(c));
    } else setText(String(value));
  };
  return (
    <div className={cx("flex min-w-0 flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={id} className="text-xs font-medium text-fg-2">
          {label}
        </label>
      )}
      <div className="flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2.5 focus-within:border-accent">
        <input
          id={id}
          inputMode="decimal"
          className="w-full min-w-0 bg-transparent font-mono text-[13px] text-fg outline-none"
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const d = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
              const v = Math.round((value + d) * 1000) / 1000;
              onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)));
            }
          }}
        />
        {unit && <span className="text-xs text-fg-3">{unit}</span>}
      </div>
    </div>
  );
}

export function TextField({ label, value, onChange, placeholder, className, autoFocus }: { label?: string; value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocus?: boolean }) {
  const id = useId();
  return (
    <div className={cx("flex min-w-0 flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={id} className="text-xs font-medium text-fg-2">
          {label}
        </label>
      )}
      <input
        id={id}
        autoFocus={autoFocus}
        className="h-8 rounded-md border border-line bg-surface-2 px-2.5 text-[13px] text-fg outline-none placeholder:text-fg-3 focus:border-accent"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function Select<T extends string>({ label, value, onChange, options, className }: { label?: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string }) {
  const id = useId();
  return (
    <div className={cx("flex min-w-0 flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={id} className="text-xs font-medium text-fg-2">
          {label}
        </label>
      )}
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-8 w-full min-w-0 truncate rounded-md border border-line bg-surface-2 px-2 text-[13px] text-fg outline-none focus:border-accent"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, className, mono }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string; mono?: boolean }) {
  return (
    <div role="radiogroup" className={cx("flex rounded-md bg-surface-2 p-[3px]", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            "h-6 min-w-0 flex-1 truncate rounded px-2 text-[11px] font-medium whitespace-nowrap transition-colors",
            mono && "font-mono",
            o.value === value ? "bg-surface-3 text-fg" : "text-fg-2 hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-xs text-fg">
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx("relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors", checked ? "bg-accent" : "bg-surface-3")}
      >
        <span className={cx("absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all", checked ? "left-[14px]" : "left-[2px]")} />
      </button>
      <span>{label}</span>
    </label>
  );
}

export function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.01,
  format,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
}) {
  const id = useId();
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between">
        <label htmlFor={id} className="text-xs font-medium text-fg-2">
          {label}
        </label>
        <span className="font-mono text-xs text-fg">{format ? format(value) : value.toFixed(2)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onDoubleClick={() => onChange(min < 0 ? 0 : min === 0.1 ? 1 : min)}
        className="h-1 w-full cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-accent [&::-webkit-slider-thumb]:bg-white"
        style={{ background: `linear-gradient(to right, var(--color-accent) ${pct}%, var(--color-surface-3) ${pct}%)` }}
      />
    </div>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <h3 className="section-title">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Collapsible({ title, subtitle, children, defaultOpen }: { title: string; subtitle?: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="border-t border-line">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 py-2.5 text-left">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-xs font-medium text-fg">{title}</span>
          {subtitle && <span className="truncate text-[11px] text-fg-3">{subtitle}</span>}
        </div>
        <span className={cx("text-fg-3 transition-transform", open && "rotate-90")}>›</span>
      </button>
      {open && <div className="flex flex-col gap-3 pb-3">{children}</div>}
    </div>
  );
}

export function Chip({ active, children, onClick, title }: { active?: boolean; children: ReactNode; onClick?: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cx(
        "h-[26px] rounded-full border px-2.5 text-xs font-medium transition-colors",
        active ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface-2 text-fg-2 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 520,
  leading,
  tabs,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** Shown before the title (e.g. a thumbnail). */
  leading?: ReactNode;
  /** Shown under the header, outside the scrolling body. */
  tabs?: ReactNode;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/65" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} style={{ width, maxWidth: "calc(100vw - 32px)" }} className="flex max-h-[90vh] flex-col rounded-xl border border-line bg-surface shadow-2xl shadow-black/60">
        <div className="flex items-center gap-3.5 border-b border-line px-5 py-4">
          {leading}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="truncate text-base font-semibold">{title}</h2>
            {subtitle && <p className="truncate text-[11px] text-fg-3">{subtitle}</p>}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>
        {tabs}
        <div className="flex flex-col gap-5 overflow-y-auto p-5">{children}</div>
        {footer && <div className="flex items-center gap-2 border-t border-line px-5 py-3.5">{footer}</div>}
      </div>
    </div>
  );
}

export function ProgressBar({ value, tone = "accent" }: { value: number; tone?: "accent" | "ok" }) {
  return (
    <div className="h-[3px] w-full overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx("h-full rounded-full transition-[width]", tone === "ok" ? "bg-ok" : "bg-accent")} style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}
