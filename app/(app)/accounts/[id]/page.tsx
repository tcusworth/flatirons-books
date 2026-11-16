import Link from "next/link";
import { notFound } from "next/navigation";
import { getBusiness } from "@/lib/business";
import { accountRegister } from "@/lib/reports";
import { fmt, fmtDate, isIsoDate, today } from "@/lib/money";
import { DateRangeForm, Money, PageHeader } from "@/components/ui";

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const t = today();
  const to = sp.to && isIsoDate(sp.to) ? sp.to : t;
  const from = sp.from && isIsoDate(sp.from) ? sp.from : `${to.slice(0, 4)}-01-01`;
  const biz = await getBusiness();
  const r = await accountRegister(biz.id, id, from, to);
  if (!r) notFound();
  return (
    <>
      <PageHeader title={`${r.account.code ? r.account.code + " · " : ""}${r.account.name}`} subtitle={`${r.account.type} · ${fmtDate(from)} – ${fmtDate(to)}`}>
        <DateRangeForm from={from} to={to} />
      </PageHeader>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr>
              <th className="th">Date</th>
              <th className="th">Description</th>
              <th className="th text-right">Debit</th>
              <th className="th text-right">Credit</th>
              <th className="th text-right">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/[0.05]">
            <tr className="bg-black/[0.02]">
              <td className="td text-muted" colSpan={4}>Balance before {fmtDate(from)}</td>
              <td className="td text-right"><Money cents={r.opening} /></td>
            </tr>
            {r.lines.map((l, i) => (
              <tr key={i}>
                <td className="td whitespace-nowrap text-muted">{fmtDate(l.entry_date)}</td>
                <td className="td">
                  <p>{l.memo || l.description}</p>
                  {l.memo && l.description && l.description !== l.memo && <p className="text-xs text-muted">{l.description}</p>}
                  {l.source === "manual" && <Link href={`/journal#${l.entry_id}`} className="text-xs text-brand-700">Journal entry</Link>}
                </td>
                <td className="td text-right tabular">{l.debit_cents ? fmt(l.debit_cents) : ""}</td>
                <td className="td text-right tabular">{l.credit_cents ? fmt(l.credit_cents) : ""}</td>
                <td className="td text-right"><Money cents={l.balance} /></td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="td" colSpan={4}>Balance at {fmtDate(to)}</td>
              <td className="td text-right"><Money cents={r.closing} /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
