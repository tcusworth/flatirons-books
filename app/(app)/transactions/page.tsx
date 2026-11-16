import Link from "next/link";
import { listTransactionRows } from "@/lib/transactions";
import { getBusiness } from "@/lib/business";
import { fmtDate } from "@/lib/money";
import { Empty, Money, PageHeader } from "@/components/ui";
import { ActionButton } from "@/components/ActionButton";
import { reopenTxn } from "../actions";

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const sp = await searchParams;
  const status = sp.status === "excluded" ? "excluded" : "posted";
  const q = (sp.q ?? "").trim();
  const biz = await getBusiness();

  const rows = await listTransactionRows(biz.id, status, q);
  return (
    <>
      <PageHeader title="Transactions" subtitle="Approved bank lines and journal entries, plus excluded bank lines. Undo sends a bank line back to the inbox.">
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
                <tr key={r.key}>
                  <td className="td whitespace-nowrap text-muted">{fmtDate(r.txn_date)}</td>
                  <td className="td">
                    <p className="font-medium">{r.title}</p>
                    <p className="text-xs text-muted">{r.subtitle}</p>
                  </td>
                  <td className="td">
                    {r.category_id ? <Link className="hover:underline" href={`/accounts/${r.category_id}`}>{r.category}</Link> : <span className="text-muted">—</span>}
                  </td>
                  <td className="td text-right"><Money cents={Number(r.display_cents)} flow /></td>
                  <td className="td text-right">
                    {r.kind === "bank" && r.txn_id ? (
                      <ActionButton action={reopenTxn.bind(null, r.txn_id)} confirm={r.status === "posted" ? "Remove from books?" : undefined}>
                        Undo
                      </ActionButton>
                    ) : (
                      <Link href="/journal" className="btn-ghost">Journal</Link>
                    )}
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
