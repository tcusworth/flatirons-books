import Link from "next/link";
import { db } from "@/lib/db";
import { getBusiness } from "@/lib/business";
import { fmt, fmtDate } from "@/lib/money";
import { Empty, PageHeader } from "@/components/ui";
import { ActionButton } from "@/components/ActionButton";
import { deleteJournalEntry } from "../actions";

type Entry = { id: string; entry_date: string; memo: string; source: string; lines: { account: string; debit: number; credit: number }[] };

export default async function JournalPage() {
  const biz = await getBusiness();
  const entries = await db()<Entry[]>`
    select e.id, e.entry_date, e.memo, e.source,
      json_agg(json_build_object('account', a.name, 'debit', l.debit_cents, 'credit', l.credit_cents) order by l.debit_cents desc, l.id) as lines
    from journal_entries e join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id
    where e.business_id = ${biz.id} and e.source in ('manual', 'opening')
    group by e.id order by e.entry_date desc, e.created_at desc limit 300`;
  return (
    <>
      <PageHeader title="Journal entries" subtitle="Manual entries and opening balances. Bank lines are posted from the inbox.">
        <Link href="/journal/new" className="btn-primary">New entry</Link>
      </PageHeader>
      {entries.length === 0 ? (
        <Empty title="No manual entries yet">Use these for owner contributions, loans, depreciation, or year-end adjustments.</Empty>
      ) : (
        <div className="space-y-3">
          {entries.map((e) => (
            <div key={e.id} id={e.id} className="card p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">{e.memo || "(no memo)"}</span>
                  <span className="ml-2 text-xs text-muted">{fmtDate(e.entry_date)}{e.source === "opening" ? " · opening balance" : ""}</span>
                </div>
                {e.source === "manual" && (
                  <ActionButton action={deleteJournalEntry.bind(null, e.id)} confirm="Delete this entry?">Delete</ActionButton>
                )}
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {e.lines.map((l, i) => (
                    <tr key={i}>
                      <td className={`py-0.5 ${l.credit ? "pl-6" : ""}`}>{l.account}</td>
                      <td className="w-28 py-0.5 text-right tabular">{l.debit ? fmt(Number(l.debit)) : ""}</td>
                      <td className="w-28 py-0.5 text-right tabular">{l.credit ? fmt(Number(l.credit)) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
