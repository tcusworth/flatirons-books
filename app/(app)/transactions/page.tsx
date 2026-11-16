import Link from "next/link";
import { db } from "@/lib/db";
import { getBusiness } from "@/lib/business";
import { fmtDate } from "@/lib/money";
import { Empty, Money, PageHeader } from "@/components/ui";
import { ActionButton } from "@/components/ActionButton";
import { reopenTxn } from "../actions";

type Row = {
  id: string;
  txn_date: string;
  description: string;
  merchant: string | null;
  amount_cents: number;
  status: string;
  bank_name: string;
  category: string | null;
  category_id: string | null;
  source: string;
};

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const sp = await searchParams;
  const status = sp.status === "excluded" ? "excluded" : "posted";
  const q = (sp.q ?? "").trim();
  const biz = await getBusiness();
  const sql = db();
  const rows = await sql<Row[]>`
    select t.id, t.txn_date, t.description, t.merchant, t.amount_cents, t.status, b.name as bank_name, t.source,
      (select string_agg(a.name, ', ') from journal_lines l join accounts a on a.id = l.account_id
        where l.entry_id = t.journal_entry_id and l.account_id <> b.ledger_account_id) as category,
      (select l.account_id from journal_lines l where l.entry_id = t.journal_entry_id and l.account_id <> b.ledger_account_id limit 1) as category_id
    from bank_transactions t join bank_accounts b on b.id = t.bank_account_id
    where t.business_id = ${biz.id} and t.status = ${status}
      ${q ? sql`and (t.description ilike ${"%" + q + "%"} or t.merchant ilike ${"%" + q + "%"})` : sql``}
    order by t.txn_date desc, t.created_at desc limit 500`;
  return (
    <>
      <PageHeader title="Transactions" subtitle="Approved and excluded bank lines. Undo sends a line back to the inbox.">
        <form className="flex gap-2">
          <input type="hidden" name="status" value={status} />
          <input name="q" defaultValue={q} placeholder="Search" className="input w-48" />
        </form>
      </PageHeader>
      <div className="mb-4 flex gap-1">
        {(["posted", "excluded"] as const).map((s) => (
          <Link key={s} href={`/transactions?status=${s}`} className={s === status ? "btn-secondary" : "btn-ghost"}>
            {s === "posted" ? "Approved" : "Excluded"}
          </Link>
        ))}
      </div>
      {rows.length === 0 ? (
        <Empty title={status === "posted" ? "Nothing approved yet" : "Nothing excluded"} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr>
                <th className="th">Date</th>
                <th className="th">Description</th>
                <th className="th">Category</th>
                <th className="th text-right">Amount</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody className="divide-y divide-black/[0.05]">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="td whitespace-nowrap text-muted">{fmtDate(r.txn_date)}</td>
                  <td className="td">
                    <p className="font-medium">{r.merchant || r.description}</p>
                    <p className="text-xs text-muted">{r.bank_name}</p>
                  </td>
                  <td className="td">
                    {r.category_id ? <Link className="hover:underline" href={`/accounts/${r.category_id}`}>{r.category}</Link> : <span className="text-muted">—</span>}
                  </td>
                  <td className="td text-right"><Money cents={-r.amount_cents} flow /></td>
                  <td className="td text-right">
                    <ActionButton action={reopenTxn.bind(null, r.id)} confirm={r.status === "posted" ? "Remove from books?" : undefined}>
                      Undo
                    </ActionButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
