import { db } from "./db";

export type ReportLine = { account_id: string; code: string | null; name: string; type: string; subtype: string | null; amount: number };

/**
 * Profit & loss for [from, to]. Income shown as credits minus debits, expenses as debits minus credits.
 * Every posted entry in this app is cash-basis (it comes from a bank line or a manual entry).
 */
export async function profitAndLoss(businessId: string, from: string, to: string) {
  const rows = await db()<ReportLine[]>`
    select a.id as account_id, a.code, a.name, a.type, a.subtype,
      sum(case when a.type = 'income' then l.credit_cents - l.debit_cents
               else l.debit_cents - l.credit_cents end)::int8 as amount
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    join accounts a on a.id = l.account_id
    where e.business_id = ${businessId} and a.type in ('income','expense')
      and e.entry_date between ${from} and ${to}
    group by a.id having sum(l.debit_cents) <> sum(l.credit_cents)
    order by a.type desc, a.code nulls last, a.name`;
  const income = rows.filter((r) => r.type === "income");
  const expense = rows.filter((r) => r.type === "expense");
  const totalIncome = income.reduce((s, r) => s + r.amount, 0);
  const totalExpense = expense.reduce((s, r) => s + r.amount, 0);
  return { income, expense, totalIncome, totalExpense, net: totalIncome - totalExpense };
}

/** P&L with one column per calendar month in [from, to]. */
export async function profitAndLossByMonth(businessId: string, from: string, to: string) {
  const rows = await db()<(ReportLine & { month: string })[]>`
    select a.id as account_id, a.code, a.name, a.type, a.subtype,
      to_char(date_trunc('month', e.entry_date), 'YYYY-MM') as month,
      sum(case when a.type = 'income' then l.credit_cents - l.debit_cents
               else l.debit_cents - l.credit_cents end)::int8 as amount
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    join accounts a on a.id = l.account_id
    where e.business_id = ${businessId} and a.type in ('income','expense')
      and e.entry_date between ${from} and ${to}
    group by a.id, date_trunc('month', e.entry_date) order by a.code nulls last, a.name`;
  const months: string[] = [];
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, (m = 1)) : m++) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  const byAccount = new Map<string, { line: ReportLine; cells: Record<string, number>; total: number }>();
  for (const r of rows) {
    const cur = byAccount.get(r.account_id) ?? { line: r, cells: {}, total: 0 };
    cur.cells[r.month] = (cur.cells[r.month] ?? 0) + r.amount;
    cur.total += r.amount;
    byAccount.set(r.account_id, cur);
  }
  const all = [...byAccount.values()].filter((x) => x.total !== 0 || Object.values(x.cells).some((v) => v !== 0));
  return {
    months,
    income: all.filter((x) => x.line.type === "income"),
    expense: all.filter((x) => x.line.type === "expense"),
  };
}

/**
 * Balance sheet as of a date. Income and expense close into equity:
 * "Retained earnings" = net income before this calendar year, "Net income" = this year to date.
 */
export async function balanceSheet(businessId: string, asOf: string) {
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const rows = await db()<ReportLine[]>`
    select a.id as account_id, a.code, a.name, a.type, a.subtype,
      sum(case when a.type = 'asset' then l.debit_cents - l.credit_cents
               else l.credit_cents - l.debit_cents end)::int8 as amount
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    join accounts a on a.id = l.account_id
    where e.business_id = ${businessId} and a.type in ('asset','liability','equity')
      and e.entry_date <= ${asOf}
    group by a.id having sum(l.debit_cents) <> sum(l.credit_cents)
    order by a.code nulls last, a.name`;
  const [ni] = await db()<{ prior: number; current: number }[]>`
    select
      coalesce(sum(case when e.entry_date < ${yearStart}
        then l.credit_cents - l.debit_cents end), 0)::int8 as prior,
      coalesce(sum(case when e.entry_date >= ${yearStart}
        then l.credit_cents - l.debit_cents end), 0)::int8 as current
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    join accounts a on a.id = l.account_id
    where e.business_id = ${businessId} and a.type in ('income','expense') and e.entry_date <= ${asOf}`;
  const assets = rows.filter((r) => r.type === "asset");
  const liabilities = rows.filter((r) => r.type === "liability");
  const equity = rows.filter((r) => r.type === "equity");
  const totalAssets = assets.reduce((s, r) => s + r.amount, 0);
  const totalLiabilities = liabilities.reduce((s, r) => s + r.amount, 0);
  const totalEquity = equity.reduce((s, r) => s + r.amount, 0) + ni.prior + ni.current;
  return {
    assets,
    liabilities,
    equity,
    priorEarnings: ni.prior,
    currentEarnings: ni.current,
    totalAssets,
    totalLiabilities,
    totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
}

/** Balance of one account as of a date, in its natural sign (debit-normal for assets/expenses). */
export async function accountRegister(businessId: string, accountId: string, from: string, to: string) {
  const [acct] = await db()<{ id: string; code: string | null; name: string; type: string }[]>`
    select id, code, name, type from accounts where id = ${accountId} and business_id = ${businessId}`;
  if (!acct) return null;
  const debitNormal = acct.type === "asset" || acct.type === "expense";
  const [open] = await db()<{ bal: number }[]>`
    select coalesce(sum(${debitNormal ? db()`l.debit_cents - l.credit_cents` : db()`l.credit_cents - l.debit_cents`}), 0)::int8 as bal
    from journal_lines l join journal_entries e on e.id = l.entry_id
    where l.account_id = ${accountId} and e.entry_date < ${from}`;
  const lines = await db()<{ entry_id: string; entry_date: string; memo: string; description: string; source: string; debit_cents: number; credit_cents: number }[]>`
    select e.id as entry_id, e.entry_date, e.memo, l.description, e.source, l.debit_cents, l.credit_cents
    from journal_lines l join journal_entries e on e.id = l.entry_id
    where l.account_id = ${accountId} and e.entry_date between ${from} and ${to}
    order by e.entry_date, e.created_at, l.id`;
  let bal = open.bal;
  const withBal = lines.map((l) => {
    bal += debitNormal ? l.debit_cents - l.credit_cents : l.credit_cents - l.debit_cents;
    return { ...l, balance: bal };
  });
  return { account: acct, opening: open.bal, lines: withBal, closing: bal };
}

/** Current ledger balance for every account (natural sign). */
export async function accountBalances(businessId: string, asOf?: string) {
  const rows = await db()<{ account_id: string; balance: number }[]>`
    select a.id as account_id,
      coalesce(sum(case when a.type in ('asset','expense') then l.debit_cents - l.credit_cents
                        else l.credit_cents - l.debit_cents end), 0)::int8 as balance
    from accounts a
    left join journal_lines l on l.account_id = a.id
    left join journal_entries e on e.id = l.entry_id
    where a.business_id = ${businessId} and (${asOf ?? null}::date is null or e.entry_date is null or e.entry_date <= ${asOf ?? null}::date)
    group by a.id`;
  return new Map(rows.map((r) => [r.account_id, r.balance]));
}
