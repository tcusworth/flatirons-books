import { fmt } from "@/lib/money";

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function Money({ cents, flow, className = "" }: { cents: number; flow?: boolean; className?: string }) {
  // flow: show money in as +green, money out as plain negative.
  const color = flow ? (cents > 0 ? "text-brand-700" : "") : cents < 0 ? "text-red-600" : "";
  return <span className={`tabular whitespace-nowrap ${color} ${className}`}>{fmt(cents, { sign: flow })}</span>;
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="card px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Stat({ label, cents, hint }: { label: string; cents: number; hint?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold tabular">{fmt(cents)}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "error"; children: React.ReactNode }) {
  const cls =
    tone === "error"
      ? "border-red-200 bg-red-50 text-red-800"
      : tone === "warn"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-brand-100 bg-brand-50 text-brand-800";
  return <div className={`mb-4 rounded-lg border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}

export function DateRangeForm({ from, to, extra }: { from: string; to: string; extra?: React.ReactNode }) {
  return (
    <form className="flex flex-wrap items-end gap-2">
      <div>
        <label className="label">From</label>
        <input type="date" name="from" defaultValue={from} className="input" />
      </div>
      <div>
        <label className="label">To</label>
        <input type="date" name="to" defaultValue={to} className="input" />
      </div>
      {extra}
      <button className="btn-secondary">Update</button>
    </form>
  );
}
