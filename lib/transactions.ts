import { db } from "@/lib/db";

export type TxnRow = {
  key: string;
  kind: "bank" | "journal";
  txn_id: string | null;
  txn_date: string;
  title: string;
  subtitle: string;
  // Display convention: positive = money in, negative = money out.
  display_cents: number;
  status: string;
  category: string | null;
  category_id: string | null;
};

/** Rows for the Transactions page: bank lines with the given status, plus (for "posted") manual journal entry lines on income/expense accounts. */
export async function listTransactionRows(businessId: string, status: "posted" | "excluded", q: string): Promise<TxnRow[]> {
  const like = "%" + q + "%";
  const sql = db();
  // Bank lines (Plaid / CSV / PDF imports). Stored amounts are positive = money out.
  const bank = sql`
    select 'b:' || t.id::text as key, 'bank' as kind, t.id::text as txn_id, t.txn_date,
      coalesce(nullif(t.merchant, ''), t.description) as title, b.name as subtitle,
      -t.amount_cents as display_cents, t.status,
      (select string_agg(a.name, ', ') from journal_lines l join accounts a on a.id = l.account_id
        where l.entry_id = t.journal_entry_id and l.account_id <> b.ledger_account_id) as category,
      (select l.account_id::text from journal_lines l where l.entry_id = t.journal_entry_id and l.account_id <> b.ledger_account_id limit 1) as category_id,
      t.created_at
    from bank_transactions t join bank_accounts b on b.id = t.bank_account_id
    where t.business_id = ${businessId} and t.status = ${status}
      ${q ? sql`and (t.description ilike ${like} or t.merchant ilike ${like})` : sql``}`;

  // Manual journal entries: one row per income/expense line. A line description that
  // starts with a date ("2026-01-14 Vendor") uses that date; otherwise the entry date.
  const journal = sql`
    select 'j:' || l.id::text as key, 'journal' as kind, null::text as txn_id,
      case when l.description ~ '^\\d{4}-\\d{2}-\\d{2}( |$)' then substr(l.description, 1, 10)::date else e.entry_date end as txn_date,
      coalesce(nullif(regexp_replace(l.description, '^\\d{4}-\\d{2}-\\d{2} ?', ''), ''), nullif(e.memo, ''), 'Journal entry') as title,
      'Journal entry' as subtitle,
      (l.credit_cents - l.debit_cents) as display_cents, 'posted' as status,
      a.name as category, a.id::text as category_id, e.created_at
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    join accounts a on a.id = l.account_id
    where e.business_id = ${businessId} and e.source = 'manual' and a.type in ('income', 'expense')
      ${q ? sql`and (l.description ilike ${like} or e.memo ilike ${like})` : sql``}`;

  return sql<TxnRow[]>`
    select * from (${bank} ${status === "posted" ? sql`union all ${journal}` : sql``}) x
    order by txn_date desc, created_at desc, key desc limit 1000`;

}
