import Link from "next/link";
import { db } from "@/lib/db";
import { getBusiness } from "@/lib/business";
import { profitAndLoss, accountBalances } from "@/lib/reports";
import { fmtDate, today } from "@/lib/money";
import { Money, PageHeader, Stat, Notice } from "@/components/ui";

export default async function Overview() {
  const biz = await getBusiness();
  const t = today();
  const monthStart = `${t.slice(0, 7)}-01`;
  const yearStart = `${t.slice(0, 4)}-01-01`;
  const [month, ytd, balances] = await Promise.all([
    profitAndLoss(biz.id, monthStart, t),
    profitAndLoss(biz.id, yearStart, t),
    accountBalances(biz.id),
  ]);
  const banks = await db()<
    { id: string; name: string; kind: string; ledger_account_id: string; current_balance_cents: number | null; plaid_item_id: string | null; status: string | null; last_synced_at: Date | null }[]
  >`
    select b.id, b.name, b.kind, b.ledger_account_id, b.current_balance_cents, b.plaid_item_id, p.status, p.last_synced_at
    from bank_accounts b left join plaid_items p on p.id = b.plaid_item_id
    where b.business_id = ${biz.id} order by b.kind, b.name`;
  const [inbox] = await db()<{ n: number; oldest: string | null }[]>`
    select count(*)::int8 as n, min(txn_date) as oldest from bank_transactions where business_id = ${biz.id} and status = 'review'`;
  const cash = banks.filter((b) => b.kind === "depository").reduce((s, b) => s + (balances.get(b.ledger_account_id) ?? 0), 0);
  const owed = banks.filter((b) => b.kind === "credit").reduce((s, b) => s + (balances.get(b.ledger_account_id) ?? 0), 0);
  const [{ pending }] = await db()<{ pending: number }[]>`
    select count(*)::int8 as pending from proposed_changes where business_id = ${biz.id} and status = 'pending'`;
  const broken = banks.filter((b) => b.status && b.status !== "active");

  return (
    <>
      <PageHeader title="Overview" subtitle={`${biz.name} · ${fmtDate(t)}`} />
      {broken.length > 0 && (
        <Notice tone="warn">
          A bank connection needs attention. <Link href="/banks" className="font-medium underline">Reconnect it on Banks</Link>.
        </Notice>
      )}
      {pending > 0 && (
        <Notice tone="warn">
          {pending} change{pending === 1 ? "" : "s"} from a connected AI app {pending === 1 ? "is" : "are"} waiting.{" "}
          <Link href="/approvals" className="font-medium underline">Review on Approvals</Link>.
        </Notice>
      )}
      {inbox.n > 0 ? (
        <Link href="/inbox" className="card mb-6 flex items-center justify-between p-4 hover:border-brand-600/40">
          <div>
            <p className="font-medium">{inbox.n} transaction{inbox.n === 1 ? "" : "s"} to review</p>
            <p className="text-sm text-muted">Oldest from {fmtDate(inbox.oldest!)}. Your reports leave these out until you approve them.</p>
          </div>
          <span className="btn-primary">Open inbox</span>
        </Link>
      ) : (
        <Notice>Your inbox is clear.</Notice>
      )}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Cash in bank (books)" cents={cash} />
        <Stat label="Owed on cards (books)" cents={owed} />
        <Stat label="Net income this month" cents={month.net} hint={`Income ${(month.totalIncome / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}`} />
        <Stat label="Net income year to date" cents={ytd.net} />
      </div>
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-black/[0.06] px-4 py-3">
          <h2 className="font-semibold">Accounts</h2>
          <Link href="/banks" className="text-sm text-brand-700 hover:underline">Manage</Link>
        </div>
        {banks.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">
            No bank accounts yet. <Link href="/banks" className="text-brand-700 underline">Connect a bank or add one for statement imports</Link>.
          </p>
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Account</th>
                <th className="th text-right">Books balance</th>
                <th className="th hidden text-right sm:table-cell">Bank says</th>
                <th className="th hidden sm:table-cell">Last sync</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/[0.05]">
              {banks.map((b) => (
                <tr key={b.id}>
                  <td className="td">
                    <Link href={`/accounts/${b.ledger_account_id}`} className="hover:underline">{b.name}</Link>
                    <span className="ml-2 text-xs text-muted">{b.kind === "credit" ? "Card" : "Bank"}</span>
                  </td>
                  <td className="td text-right"><Money cents={balances.get(b.ledger_account_id) ?? 0} /></td>
                  <td className="td hidden text-right text-muted sm:table-cell">
                    {b.current_balance_cents == null ? "—" : <Money cents={b.current_balance_cents} />}
                  </td>
                  <td className="td hidden text-xs text-muted sm:table-cell">
                    {b.plaid_item_id ? (b.last_synced_at ? new Date(b.last_synced_at).toLocaleString("en-US") : "Never") : "Statement imports"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="mt-3 text-xs text-muted">
        &ldquo;Books&rdquo; balances only include approved transactions and opening balances. Pending inbox lines aren&apos;t counted yet.
      </p>
    </>
  );
}
