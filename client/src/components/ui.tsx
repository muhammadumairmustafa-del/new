import React, { useState } from "react";
import { X, AlertTriangle, Info, type LucideIcon } from "lucide-react";
import { pkr } from "../format";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Card({ title, subtitle, actions, children, className, pad = true }: { title?: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx("bg-card text-card-foreground rounded-lg border border-card-border", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
          <div>{title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}{subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}</div>
          {actions && <div className="flex gap-2 items-center flex-wrap justify-end">{actions}</div>}
        </header>
      )}
      <div className={pad ? "px-5 pb-5" : "pb-1"}>{children}</div>
    </section>
  );
}

const toneText: Record<string, string> = {
  default: "text-foreground", bad: "text-rose-600 dark:text-rose-400", good: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400", blue: "text-blue-600 dark:text-blue-400", violet: "text-violet-600 dark:text-violet-400",
};
const toneBg: Record<string, string> = {
  default: "bg-muted", bad: "bg-rose-50 dark:bg-rose-950/30", good: "bg-emerald-50 dark:bg-emerald-950/30",
  warn: "bg-amber-50 dark:bg-amber-950/30", blue: "bg-blue-50 dark:bg-blue-950/30", violet: "bg-violet-50 dark:bg-violet-950/30",
};
export type Tone = "default" | "bad" | "good" | "warn" | "blue" | "violet";

export function Stat({ label, value, sub, tone = "default", icon: Icon, onClick }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone; icon?: LucideIcon; onClick?: () => void }) {
  return (
    <div onClick={onClick} className={cx("bg-card rounded-lg border border-card-border p-4 transition", onClick && "cursor-pointer hover:border-primary/40 hover:shadow-sm")}>
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1 min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className={cx("text-xl font-bold tabular-nums", toneText[tone])}>{value}</p>
          {sub && <p className="text-[11px] text-muted-foreground leading-snug">{sub}</p>}
        </div>
        {Icon && <div className={cx("w-9 h-9 rounded-md flex items-center justify-center shrink-0", toneBg[tone])}><Icon className={cx("w-4 h-4", tone === "default" ? "text-muted-foreground" : toneText[tone])} /></div>}
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between flex-wrap gap-3">
      <div><h1 className="text-2xl font-bold tracking-tight">{title}</h1>{subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}</div>
      {actions && <div className="flex gap-2 items-center flex-wrap no-print">{actions}</div>}
    </div>
  );
}

export function Button({ variant = "primary", size = "md", className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" }) {
  const v = {
    primary: "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50",
    secondary: "bg-background border border-border text-foreground hover:bg-muted disabled:opacity-50",
    ghost: "text-muted-foreground hover:text-foreground hover:bg-muted",
    danger: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  }[variant];
  return <button {...p} className={cx("inline-flex items-center gap-1.5 rounded-md font-medium transition disabled:cursor-not-allowed", size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm", v, className)} />;
}

const sevCls: Record<string, string> = {
  critical: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900",
  high: "bg-orange-50 text-orange-700 ring-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:ring-orange-900",
  medium: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900",
  low: "bg-muted text-muted-foreground ring-border",
  good: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900",
  info: "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-900",
};
export function Badge({ tone = "low", children }: { tone?: string; children: React.ReactNode }) {
  return <span className={cx("inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset whitespace-nowrap capitalize", sevCls[tone] ?? sevCls.low)}>{children}</span>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex gap-1 p-1 rounded-lg bg-muted mb-4 overflow-x-auto no-print">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)} className={cx("px-3 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition", value === t.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>{t.label}</button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-[2px] flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className={cx("bg-background border border-border rounded-xl shadow-2xl w-full mt-10", wide ? "max-w-4xl" : "max-w-lg")} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border"><h3 className="font-semibold">{title}</h3><button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X size={18} /></button></div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Callout({ tone = "warn", title, children }: { tone?: "warn" | "info" | "bad"; title?: string; children: React.ReactNode }) {
  const cls = {
    warn: "bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-200",
    info: "bg-blue-50 border-blue-200 text-blue-900 dark:bg-blue-950/30 dark:border-blue-900 dark:text-blue-200",
    bad: "bg-rose-50 border-rose-200 text-rose-900 dark:bg-rose-950/30 dark:border-rose-900 dark:text-rose-200",
  }[tone];
  const Icon = tone === "info" ? Info : AlertTriangle;
  return <div className={cx("border rounded-lg px-4 py-3 text-sm flex gap-3", cls)}><Icon size={18} className="shrink-0 mt-0.5" /><div>{title && <div className="font-semibold mb-0.5">{title}</div>}{children}</div></div>;
}

export function Money({ v, className, compact, colored }: { v: number | null | undefined; className?: string; compact?: boolean; colored?: boolean }) {
  if (v === null || v === undefined) return <span className={cx("num text-muted-foreground", className)}>–</span>;
  return <span className={cx("num", colored && v < 0 && "text-rose-600 dark:text-rose-400", colored && v > 0 && "text-emerald-700 dark:text-emerald-400", className)}>{pkr(v, { compact })}</span>;
}

export function Loading({ q }: { q: { isLoading: boolean; error: unknown } }) {
  if (q.isLoading) return (
    <div className="space-y-4 animate-pulse">
      <div className="h-7 w-64 bg-muted rounded" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{[1, 2, 3, 4].map((i) => <div key={i} className="h-24 bg-muted rounded-lg" />)}</div>
      <div className="h-64 bg-muted rounded-lg" />
    </div>);
  if (q.error) return <Callout tone="bad" title="Could not load">{String((q.error as Error).message)}</Callout>;
  return null;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-sm text-muted-foreground py-10 text-center border border-dashed border-border rounded-lg">{children}</div>;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="label">{label}</span>{children}</label>;
}

export function useToggle(init = false) { const [v, set] = useState(init); return [v, () => set((x) => !x), set] as const; }

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
      <span className={cx("relative inline-block w-8 rounded-full transition", checked ? "bg-primary" : "bg-input")} style={{ height: 18 }}>
        <span className={cx("absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-all", checked ? "left-4" : "left-0.5")} />
      </span>
      <input type="checkbox" className="sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />{label}
    </label>
  );
}
