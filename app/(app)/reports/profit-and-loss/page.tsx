import Link from "next/link";
import { getBusiness } from "@/lib/business";
import { profitAndLoss, profitAndLossByMonth } from "@/lib/reports";
import { fmt, fmtDate, isIsoDate, today } from "@/lib/money";
import { DateRangeForm, Money, PageHeader } from "@/components/ui";

function monthLabel(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

export default async function PnlPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; view?: string }> }) {
  const sp = await searchParams;
  const t = today();
  const from = sp.from && isIsoDate(sp.from) ? sp.from : `${t.slice(0, 4)}-01-01`;
  const to = sp.to && isIsoDate(sp.to) ? sp.to : t;
  const byMonth = sp.view === "month";
  const biz = await getBusiness();
  const range = `${fmtDate(from)} – ${fmtDate(to)}`;
  const qs = (v?: string) => `?from=${from}&to=${to}${v ? `&view=${v}` : ""}`;

  const header = (
    <PageHeader title="Profit & loss" subtitle={`${biz.name} · ${range} · cash basis`}>
      <DateRangeForm from={from} to={to} extra={byMonth ? <input type="hidden" name="view" value="month" /> : null} />
    </PageHeader>
  );
  const toggle = (
    <div className="mb-4 flex gap-1">
      <Link href={qs()} className={!byMonth ? "btn-secondary" : "btn-ghost"}>Total</Link>
      <Link href={qs("month")} className={byMonth ? "btn-secondary" : "btn-ghost"}>By month</Link>
    </div>
  );

  if (byMonth) {
    const r = await profitAndLossByMonth(biz.id, from, to);
    const sum = (rows: typeof r.income, m: string) => rows.reduce((s, x) => s + (x.cells[m] ?? 0), 0);
    const section = (title: string, rows: typeof r.income) => (
      <>
        <tr className="bg-black/[0.02]"><td className="td font-semibold" colSpan={r.months.length + 2}>{title}</td></tr>
        {rows.map((x) => (
          <tr key={x.line.account_id}>
            <td className="td sticky left-0 bg-white"><Link className="hover:underline" href={`/accounts/${x.line.account_id}?from=${from}&to=${to}`}>{x.line.name}</Link></td>
            {r.months.map((m) => <td key={m} className="td text-right tabular">{x.cells[m] ? fmt(x.cells[m]) : "—"}</td>)}
            <td className="td text-right font-medium tabular">{fmt(x.total)}</td>
          </tr>
        ))}
        <tr className="font-semibold">
          <td className="td sticky left-0 bg-white">Total {title.toLowerCase()}</td>
          {r.months.map((m) => <td key={m} className="td text-right tabular">{fmt(sum(rows, m))}</td>)}
          <td className="td text-right tabular">{fmt(rows.reduce((s, x) => s + x.total, 0))}</td>
        </tr>
      </>
    );
    const net = (m?: string) => (m ? sum(r.income, m) - sum(r.expense, m) : r.income.reduce((s, x) => s + x.total, 0) - r.expense.reduce((s, x) => s + x.total, 0));
    return (
      <>
        {header}
        {toggle}
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr><th className="th sticky left-0 bg-white">Account</th>{r.months.map((m) => <th key={m} className="th text-right">{monthLabel(m)}</th>)}<th className="th text-right">Total</th></tr></thead>
            <tbody className="divide-y divide-black/[0.05]">
              {section("Income", r.income)}
              {section("Expenses", r.expense)}
              <tr className="border-t-2 border-black/10 font-semibold">
                <td className="td sticky left-0 bg-white">Net income</td>
                {r.months.map((m) => <td key={m} className="td text-right"><Money cents={net(m)} /></td>)}
                <td className="td text-right"><Money cents={net()} /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </>
    );
  }

  const r = await profitAndLoss(biz.id, from, to);
  const block = (title: string, rows: typeof r.income, total: number) => (
    <div className="card mb-4 overflow-hidden">
      <div className="border-b border-black/[0.06] px-4 py-2.5 font-semibold">{title}</div>
      <table className="w-full">
        <tbody className="divide-y divide-black/[0.05]">
          {rows.length === 0 && <tr><td className="td text-muted">Nothing in this period.</td></tr>}
          {rows.map((x) => (
            <tr key={x.account_id}>
              <td className="td"><Link className="hover:underline" href={`/accounts/${x.account_id}?from=${from}&to=${to}`}>{x.code ? `${x.code} · ` : ""}{x.name}</Link></td>
              <td className="td text-right"><Money cents={x.amount} /></td>
            </tr>
          ))}
          <tr className="bg-black/[0.02] font-semibold"><td className="td">Total {title.toLowerCase()}</td><td className="td text-right"><Money cents={total} /></td></tr>
        </tbody>
      </table>
    </div>
  );
  return (
    <>
      {header}
      {toggle}
      {block("Income", r.income, r.totalIncome)}
      {block("Expenses", r.expense, r.totalExpense)}
      <div className="card flex items-center justify-between px-4 py-3">
        <span className="font-display text-lg font-semibold">Net income</span>
        <Money cents={r.net} className="font-display text-lg font-semibold" />
      </div>
      <p className="mt-3 text-xs text-muted">Only approved transactions are included. Lines waiting in the inbox are left out.</p>
    </>
  );
}
