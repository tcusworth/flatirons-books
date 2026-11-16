import { db } from "@/lib/db";
import { getBusiness } from "@/lib/business";
import { plaidConfigured } from "@/lib/plaid";
import { fmtDate, today } from "@/lib/money";
import { Money, Notice, PageHeader } from "@/components/ui";
import { ActionButton } from "@/components/ActionButton";
import { addManualBank, disconnectItem, setOpening, syncNow } from "../actions";
import { PlaidConnect } from "./PlaidConnect";
import { ImportPanel } from "./ImportPanel";

type Item = { id: string; institution_name: string; status: string; last_error: string | null; last_synced_at: Date | null };
type Bank = {
  id: string;
  name: string;
  kind: "depository" | "credit";
  mask: string | null;
  plaid_item_id: string | null;
  current_balance_cents: number | null;
  opening_date: string | null;
  opening_cents: number | null;
  first_txn: string | null;
  count: number;
};

export default async function BanksPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const biz = await getBusiness();
  const sql = db();
  const items = await sql<Item[]>`
    select id, institution_name, status, last_error, last_synced_at from plaid_items where business_id = ${biz.id} order by created_at`;
  const banks = await sql<Bank[]>`
    select b.id, b.name, b.kind, b.mask, b.plaid_item_id, b.current_balance_cents,
      (select e.entry_date from journal_entries e join journal_lines l on l.entry_id = e.id
        where e.source = 'opening' and l.account_id = b.ledger_account_id limit 1) as opening_date,
      (select case when b.kind = 'depository' then l.debit_cents - l.credit_cents else l.credit_cents - l.debit_cents end
        from journal_entries e join journal_lines l on l.entry_id = e.id
        where e.source = 'opening' and l.account_id = b.ledger_account_id limit 1) as opening_cents,
      (select min(txn_date) from bank_transactions t where t.bank_account_id = b.id) as first_txn,
      (select count(*)::int8 from bank_transactions t where t.bank_account_id = b.id) as count
    from bank_accounts b where b.business_id = ${biz.id} order by b.kind, b.name`;
  const plaidOn = plaidConfigured();

  return (
    <>
      <PageHeader title="Banks & imports" subtitle="Live bank feeds through Plaid, or statement files for accounts that can't connect.">
        {items.length > 0 && (
          <ActionButton action={syncNow.bind(null, undefined)} className="btn-secondary">Sync all now</ActionButton>
        )}
        {plaidOn && <PlaidConnect />}
      </PageHeader>
      {error === "opening" && <Notice tone="error">Opening balance needs a date and an amount.</Notice>}
      {!plaidOn && (
        <Notice tone="warn">
          Bank feeds are off: set <code>PLAID_CLIENT_ID</code> and <code>PLAID_SECRET</code> (and <code>PLAID_ENV</code>) to turn them on.
          CSV and PDF imports work without Plaid.
        </Notice>
      )}

      {items.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 text-sm font-semibold text-muted">Bank connections</h2>
          <div className="card divide-y divide-black/[0.05]">
            {items.map((it) => (
              <div key={it.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{it.institution_name || "Bank"}</p>
                  <p className="text-xs text-muted">
                    {it.last_synced_at ? `Synced ${new Date(it.last_synced_at).toLocaleString("en-US")}` : "Not synced yet"}
                    {it.status !== "active" && <span className="ml-2 text-red-600">{it.status === "login_required" ? "Sign-in expired" : "Error"}: {it.last_error}</span>}
                  </p>
                </div>
                {it.status === "login_required" && plaidOn && <PlaidConnect itemId={it.id} label="Reconnect" />}
                <ActionButton action={syncNow.bind(null, it.id)} className="btn-secondary">Sync</ActionButton>
                <ActionButton action={disconnectItem.bind(null, it.id)} confirm="Disconnect? History stays.">Disconnect</ActionButton>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold text-muted">Accounts</h2>
        {banks.length === 0 ? (
          <p className="card px-4 py-6 text-sm text-muted">No accounts yet. Connect a bank above, or add one below for statement imports.</p>
        ) : (
          <div className="space-y-3">
            {banks.map((b) => (
              <div key={b.id} className="card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{b.name}</p>
                    <p className="text-xs text-muted">
                      {b.kind === "credit" ? "Credit card" : "Bank account"} · {b.plaid_item_id ? "Live feed" : "Statement imports"} · {b.count} lines
                      {b.first_txn ? ` since ${fmtDate(b.first_txn)}` : ""}
                      {b.current_balance_cents != null && <> · bank balance <Money cents={b.current_balance_cents} /></>}
                    </p>
                  </div>
                  <form action={setOpening} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="bank_account_id" value={b.id} />
                    <div>
                      <label className="label">Opening balance date</label>
                      <input type="date" name="date" defaultValue={b.opening_date ?? b.first_txn ?? today()} className="input" />
                    </div>
                    <div>
                      <label className="label">{b.kind === "credit" ? "Amount owed" : "Balance"}</label>
                      <input name="balance" defaultValue={b.opening_cents != null ? (b.opening_cents / 100).toFixed(2) : ""} placeholder="0.00" className="input w-32" />
                    </div>
                    <button className="btn-secondary">{b.opening_cents != null ? "Update" : "Set"}</button>
                  </form>
                </div>
                <p className="mt-2 text-xs text-muted">
                  Opening balance = the balance just before your first line here (from the statement). It posts against Opening Balance Equity.
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {banks.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 text-sm font-semibold text-muted">Import a statement</h2>
          <ImportPanel banks={banks.map((b) => ({ id: b.id, name: b.name, kind: b.kind, live: Boolean(b.plaid_item_id) }))} pdfOn={Boolean(process.env.ANTHROPIC_API_KEY)} />
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-muted">Add an account for statement imports</h2>
        <form action={addManualBank} className="card flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-48 flex-1">
            <label className="label">Name</label>
            <input name="name" required placeholder="e.g. Elevations CU Checking" className="input" />
          </div>
          <div>
            <label className="label">Type</label>
            <select name="kind" className="input">
              <option value="depository">Bank account</option>
              <option value="credit">Credit card</option>
            </select>
          </div>
          <div>
            <label className="label">Last 4</label>
            <input name="mask" maxLength={4} className="input w-20" />
          </div>
          <button className="btn-primary">Add account</button>
        </form>
      </section>
    </>
  );
}
