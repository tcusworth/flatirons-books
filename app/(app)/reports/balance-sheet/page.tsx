import Link from "next/link";
import { getBusiness } from "@/lib/business";
import { balanceSheet } from "@/lib/reports";
import { fmtDate, isIsoDate, today } from "@/lib/money";
import { Money, Notice, PageHeader } from "@/components/ui";

export default async function BalanceSheetPage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const sp = await searchParams;
  const asOf = sp.asOf && isIsoDate(sp.asOf) ? sp.asOf : today();
  const biz = await getBusiness();
  const r = await balanceSheet(biz.id, asOf);
  const year = asOf.slice(0, 4);
  type L = (typeof r.assets)[number];
  const rows = (list: L[]) =>
    list.map((x) => (
      <tr key={x.account_id}>
        <td className="td"><Link className="hover:underline" href={`/accounts/${x.account_id}?to=${asOf}`}>{x.code ? `${x.code} · ` : ""}{x.name}</Link></td>
        <td className="td text-right"><Money cents={x.amount} /></td>
      </tr>
    ));
  const total = (label: string, cents: number) => (
    <tr className="bg-black/[0.02] font-semibold"><td className="td">{label}</td><td className="td text-right"><Money cents={cents} /></td></tr>
  );
  return (
    <>
      <PageHeader title="Balance sheet" subtitle={`${biz.name} · as of ${fmtDate(asOf)}`}>
        <form className="flex items-end gap-2">
          <div>
            <label className="label">As of</label>
            <input type="date" name="asOf" defaultValue={asOf} className="input" />
          </div>
          <button className="btn-secondary">Update</button>
        </form>
      </PageHeader>
      {!r.balanced && <Notice tone="error">Assets don&apos;t equal liabilities plus equity. This shouldn&apos;t happen; check recent manual entries.</Notice>}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card self-start overflow-hidden">
          <div className="border-b border-black/[0.06] px-4 py-2.5 font-semibold">Assets</div>
          <table className="w-full"><tbody className="divide-y divide-black/[0.05]">
            {rows(r.assets)}
            {total("Total assets", r.totalAssets)}
          </tbody></table>
        </div>
        <div className="card self-start overflow-hidden">
          <div className="border-b border-black/[0.06] px-4 py-2.5 font-semibold">Liabilities</div>
          <table className="w-full"><tbody className="divide-y divide-black/[0.05]">
            {r.liabilities.length === 0 && <tr><td className="td text-muted" colSpan={2}>None</td></tr>}
            {rows(r.liabilities)}
            {total("Total liabilities", r.totalLiabilities)}
          </tbody></table>
          <div className="border-y border-black/[0.06] px-4 py-2.5 font-semibold">Equity</div>
          <table className="w-full"><tbody className="divide-y divide-black/[0.05]">
            {rows(r.equity)}
            <tr><td className="td">Retained earnings (before {year})</td><td className="td text-right"><Money cents={r.priorEarnings} /></td></tr>
            <tr><td className="td">Net income ({year} to date)</td><td className="td text-right"><Money cents={r.currentEarnings} /></td></tr>
            {total("Total equity", r.totalEquity)}
            {total("Liabilities + equity", r.totalLiabilities + r.totalEquity)}
          </tbody></table>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">A credit card shows a negative liability when you&apos;ve paid it down below zero (a credit balance).</p>
    </>
  );
}
