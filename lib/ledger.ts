import { db, type Q } from "./db";
import { accountBySubtype, nextCode } from "./business";
import { isIsoDate } from "./money";
import { normalizeText, rulePatternFor } from "./rules";

export class LedgerError extends Error {}

export type LineInput = { accountId: string; debit?: number; credit?: number; description?: string };

/** Insert a balanced journal entry. Throws LedgerError on bad input; the DB trigger is the final guard. */
export async function createEntry(
  q: Q,
  input: { businessId: string; date: string; memo: string; source: "manual" | "bank" | "transfer" | "opening"; lines: LineInput[] }
): Promise<string> {
  if (!isIsoDate(input.date)) throw new LedgerError("Invalid date");
  const lines = input.lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
  if (lines.length < 2) throw new LedgerError("An entry needs at least two lines");
  for (const l of lines) {
    const d = l.debit ?? 0;
    const c = l.credit ?? 0;
    if (!Number.isInteger(d) || !Number.isInteger(c) || d < 0 || c < 0) throw new LedgerError("Amounts must be positive cents");
    if (d > 0 && c > 0) throw new LedgerError("A line can't have both a debit and a credit");
  }
  const dr = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const cr = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (dr !== cr) throw new LedgerError(`Debits (${dr}) and credits (${cr}) must be equal`);

  const ids = [...new Set(lines.map((l) => l.accountId))];
  const found = await q<{ id: string }[]>`
    select id from accounts where business_id = ${input.businessId} and id in ${q(ids)}`;
  if (found.length !== ids.length) throw new LedgerError("Unknown account on one of the lines");

  const [entry] = await q<{ id: string }[]>`
    insert into journal_entries (business_id, entry_date, memo, source)
    values (${input.businessId}, ${input.date}, ${input.memo}, ${input.source}) returning id`;
  for (const l of lines) {
    await q`
      insert into journal_lines (entry_id, account_id, debit_cents, credit_cents, description)
      values (${entry.id}, ${l.accountId}, ${l.debit ?? 0}, ${l.credit ?? 0}, ${l.description ?? ""})`;
  }
  return entry.id;
}

export async function deleteEntry(q: Q, businessId: string, entryId: string): Promise<void> {
  await q`
    update bank_transactions set status = 'review', journal_entry_id = null
    where journal_entry_id = ${entryId} and business_id = ${businessId}`;
  await q`delete from journal_entries where id = ${entryId} and business_id = ${businessId}`;
}

type BankTxnRow = {
  id: string;
  business_id: string;
  txn_date: string;
  description: string;
  merchant: string | null;
  amount_cents: number;
  status: string;
  ledger_account_id: string;
  bank_name: string;
};

async function loadTxn(q: Q, businessId: string, txnId: string): Promise<BankTxnRow> {
  const [t] = await q<BankTxnRow[]>`
    select t.id, t.business_id, t.txn_date, t.description, t.merchant, t.amount_cents, t.status,
           b.ledger_account_id, b.name as bank_name
    from bank_transactions t join bank_accounts b on b.id = t.bank_account_id
    where t.id = ${txnId} and t.business_id = ${businessId}
    for update of t`;
  if (!t) throw new LedgerError("Transaction not found");
  if (t.status !== "review") throw new LedgerError("Transaction is already posted or excluded");
  return t;
}

/**
 * Post a bank transaction against a category account.
 * Money out (amount > 0): debit the category, credit the bank/card account.
 * Money in  (amount < 0): debit the bank/card account, credit the category.
 * The same rule is right for checking (an asset) and credit cards (a liability).
 */
export async function postBankTransaction(
  businessId: string,
  txnId: string,
  categoryAccountId: string,
  opts: { remember?: boolean } = {}
): Promise<string> {
  return db().begin(async (q) => {
    const t = await loadTxn(q, businessId, txnId);
    if (categoryAccountId === t.ledger_account_id) throw new LedgerError("Pick a category other than the bank account itself");
    const amt = Math.abs(t.amount_cents);
    const out = t.amount_cents > 0;
    const entryId = await createEntry(q, {
      businessId,
      date: t.txn_date,
      memo: t.merchant || t.description,
      source: "bank",
      lines: [
        { accountId: categoryAccountId, debit: out ? amt : 0, credit: out ? 0 : amt, description: t.description },
        { accountId: t.ledger_account_id, debit: out ? 0 : amt, credit: out ? amt : 0, description: t.description },
      ],
    });
    await q`
      update bank_transactions set status = 'posted', journal_entry_id = ${entryId},
        transfer_match_id = null
      where id = ${t.id}`;
    if (opts.remember) {
      const pattern = rulePatternFor(t.merchant, t.description);
      if (pattern) {
        await q`
          insert into categorization_rules (business_id, pattern, account_id)
          values (${businessId}, ${pattern}, ${categoryAccountId})
          on conflict (business_id, pattern) do update set account_id = excluded.account_id`;
      }
    }
    return entryId;
  });
}

/** Post two matched bank transactions (money out of A, the same money into B) as one transfer entry. */
export async function postTransfer(businessId: string, outTxnId: string, inTxnId: string): Promise<string> {
  return db().begin(async (q) => {
    const a = await loadTxn(q, businessId, outTxnId);
    const b = await loadTxn(q, businessId, inTxnId);
    if (!(a.amount_cents > 0 && b.amount_cents === -a.amount_cents)) {
      throw new LedgerError("These two transactions don't offset each other");
    }
    if (a.ledger_account_id === b.ledger_account_id) throw new LedgerError("A transfer needs two different accounts");
    const amt = a.amount_cents;
    const entryId = await createEntry(q, {
      businessId,
      date: a.txn_date < b.txn_date ? a.txn_date : b.txn_date,
      memo: `Transfer: ${a.bank_name} → ${b.bank_name}`,
      source: "transfer",
      lines: [
        { accountId: b.ledger_account_id, debit: amt, description: b.description },
        { accountId: a.ledger_account_id, credit: amt, description: a.description },
      ],
    });
    await q`
      update bank_transactions set status = 'posted', journal_entry_id = ${entryId}
      where id in ${q([a.id, b.id])}`;
    return entryId;
  });
}

export async function excludeTransaction(businessId: string, txnId: string): Promise<void> {
  await db()`
    update bank_transactions set status = 'excluded', transfer_match_id = null
    where id = ${txnId} and business_id = ${businessId} and status = 'review'`;
  await db()`
    update bank_transactions set transfer_match_id = null, suggestion_source = null,
      suggested_account_id = null, suggestion_confidence = null, suggestion_reason = null
    where transfer_match_id = ${txnId} and business_id = ${businessId} and status = 'review'`;
}

/** Undo: posted -> back to the inbox (deletes its journal entry); excluded -> back to the inbox. */
export async function reopenTransaction(businessId: string, txnId: string): Promise<void> {
  await db().begin(async (q) => {
    const [t] = await q<{ status: string; journal_entry_id: string | null }[]>`
      select status, journal_entry_id from bank_transactions
      where id = ${txnId} and business_id = ${businessId} for update`;
    if (!t) throw new LedgerError("Transaction not found");
    if (t.journal_entry_id) {
      await deleteEntry(q, businessId, t.journal_entry_id);
    } else {
      await q`update bank_transactions set status = 'review' where id = ${txnId}`;
    }
  });
}

/** Create the ledger account behind a bank or card account. */
export async function createLedgerAccountForBank(
  q: Q,
  businessId: string,
  name: string,
  kind: "depository" | "credit"
): Promise<string> {
  const isCard = kind === "credit";
  const code = isCard ? await nextCode(businessId, 2100, 2199, q) : await nextCode(businessId, 1000, 1099, q);
  const [a] = await q<{ id: string }[]>`
    insert into accounts (business_id, code, name, type, subtype)
    values (${businessId}, ${code}, ${name}, ${isCard ? "liability" : "asset"}, ${isCard ? "credit_card" : "bank"})
    returning id`;
  return a.id;
}

export async function createManualBankAccount(businessId: string, name: string, kind: "depository" | "credit", mask?: string) {
  return db().begin(async (q) => {
    const ledgerId = await createLedgerAccountForBank(q, businessId, name, kind);
    const [b] = await q<{ id: string }[]>`
      insert into bank_accounts (business_id, ledger_account_id, name, mask, kind)
      values (${businessId}, ${ledgerId}, ${name}, ${mask || null}, ${kind}) returning id`;
    return b.id;
  });
}

/**
 * Record an opening balance for a bank or card account.
 * balanceCents is what the bank shows: money in the account, or the amount owed on a card.
 */
export async function setOpeningBalance(businessId: string, bankAccountId: string, date: string, balanceCents: number) {
  return db().begin(async (q) => {
    const [b] = await q<{ ledger_account_id: string; kind: string; name: string }[]>`
      select ledger_account_id, kind, name from bank_accounts where id = ${bankAccountId} and business_id = ${businessId}`;
    if (!b) throw new LedgerError("Bank account not found");
    const obe = await accountBySubtype(businessId, "opening_balance", q);
    if (!obe) throw new LedgerError("No Opening Balance Equity account");
    // Replace any earlier opening entry for this account.
    const old = await q<{ id: string }[]>`
      select e.id from journal_entries e join journal_lines l on l.entry_id = e.id
      where e.business_id = ${businessId} and e.source = 'opening' and l.account_id = ${b.ledger_account_id}`;
    for (const o of old) await q`delete from journal_entries where id = ${o.id}`;
    if (balanceCents === 0) return null;
    const amt = Math.abs(balanceCents);
    // Asset with money in it, or a card with money owed, both mean "balance > 0".
    const bankIsDebit = b.kind === "depository" ? balanceCents > 0 : balanceCents < 0;
    return createEntry(q, {
      businessId,
      date,
      memo: `Opening balance: ${b.name}`,
      source: "opening",
      lines: [
        { accountId: b.ledger_account_id, debit: bankIsDebit ? amt : 0, credit: bankIsDebit ? 0 : amt },
        { accountId: obe.id, debit: bankIsDebit ? 0 : amt, credit: bankIsDebit ? amt : 0 },
      ],
    });
  });
}

export { normalizeText };
