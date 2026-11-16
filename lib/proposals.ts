import { z } from "zod";
import { db } from "./db";
import * as L from "./ledger";
import { categorizeInbox } from "./categorize";
import { fmt, isIsoDate } from "./money";

/**
 * Changes prepared by an AI app through the connector. They are validated when proposed,
 * shown on the Approvals page, and only applied when the owner approves them.
 */

export const CategorizePayload = z.object({
  items: z.array(z.object({ transaction_id: z.string().uuid(), account_id: z.string().uuid() })).min(1).max(200),
  remember: z.boolean().default(false),
});
export const ExcludePayload = z.object({ transaction_ids: z.array(z.string().uuid()).min(1).max(200) });
export const JournalPayload = z.object({
  date: z.string().refine(isIsoDate, "date must be YYYY-MM-DD"),
  memo: z.string().max(300),
  lines: z
    .array(
      z.object({
        account_id: z.string().uuid(),
        debit_cents: z.number().int().min(0),
        credit_cents: z.number().int().min(0),
        description: z.string().max(300).default(""),
      })
    )
    .min(2)
    .max(50),
});
export const RulePayload = z.object({ pattern: z.string().trim().min(2).max(100), account_id: z.string().uuid() });
export const AccountPayload = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(["asset", "liability", "equity", "income", "expense"]),
  code: z.string().trim().max(10).nullable().default(null),
});

export type Kind = "categorize" | "exclude" | "journal_entry" | "create_rule" | "create_account";

export class ProposalError extends Error {}

type Acct = { id: string; name: string; type: string; subtype: string | null; is_archived: boolean };

async function accountsById(businessId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, Acct>();
  const rows = await db()<Acct[]>`
    select id, name, type, subtype, is_archived from accounts where business_id = ${businessId} and id in ${db()(ids)}`;
  return new Map(rows.map((r) => [r.id, r]));
}

function requireCategory(map: Map<string, Acct>, id: string) {
  const a = map.get(id);
  if (!a) throw new ProposalError(`Unknown account ${id}. Call list_accounts for valid ids.`);
  if (a.is_archived) throw new ProposalError(`Account "${a.name}" is archived.`);
  if (a.subtype === "bank" || a.subtype === "credit_card") {
    throw new ProposalError(`"${a.name}" is a bank or card account. Use a category account, or propose a transfer as a journal entry.`);
  }
  return a;
}

/** Validate and store a proposal. Returns its id and a one-line summary. */
export async function createProposal(
  businessId: string,
  kind: Kind,
  rawPayload: unknown,
  opts: { note?: string; clientName?: string } = {}
): Promise<{ id: string; summary: string }> {
  const sql = db();
  let payload: unknown;
  let summary: string;

  if (kind === "categorize") {
    const p = CategorizePayload.parse(rawPayload);
    const txIds = [...new Set(p.items.map((i) => i.transaction_id))];
    if (txIds.length !== p.items.length) throw new ProposalError("Each transaction can appear only once.");
    const txns = await sql<{ id: string; status: string }[]>`
      select id, status from bank_transactions where business_id = ${businessId} and id in ${sql(txIds)}`;
    if (txns.length !== txIds.length) throw new ProposalError("One or more transaction ids weren't found. Use search_transactions or list_inbox.");
    const accts = await accountsById(businessId, [...new Set(p.items.map((i) => i.account_id))]);
    p.items.forEach((i) => requireCategory(accts, i.account_id));
    const names = [...new Set(p.items.map((i) => accts.get(i.account_id)!.name))];
    const recats = txns.filter((t) => t.status !== "review").length;
    summary = `Categorize ${p.items.length} transaction${p.items.length > 1 ? "s" : ""} as ${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}${recats ? ` (${recats} already in the books will be re-categorized)` : ""}${p.remember ? ", and remember as rules" : ""}`;
    payload = p;
  } else if (kind === "exclude") {
    const p = ExcludePayload.parse(rawPayload);
    const txns = await sql<{ id: string; status: string }[]>`
      select id, status from bank_transactions where business_id = ${businessId} and id in ${sql(p.transaction_ids)}`;
    if (txns.length !== new Set(p.transaction_ids).size) throw new ProposalError("One or more transaction ids weren't found.");
    if (txns.some((t) => t.status !== "review")) throw new ProposalError("Only inbox transactions can be excluded. Posted ones must be undone in the app.");
    summary = `Exclude ${p.transaction_ids.length} inbox transaction${p.transaction_ids.length > 1 ? "s" : ""} from the books`;
    payload = p;
  } else if (kind === "journal_entry") {
    const p = JournalPayload.parse(rawPayload);
    for (const l of p.lines) {
      if ((l.debit_cents > 0) === (l.credit_cents > 0)) throw new ProposalError("Each line needs either a debit or a credit, not both or neither.");
    }
    const dr = p.lines.reduce((s, l) => s + l.debit_cents, 0);
    const cr = p.lines.reduce((s, l) => s + l.credit_cents, 0);
    if (dr !== cr) throw new ProposalError(`Out of balance: debits ${fmt(dr)}, credits ${fmt(cr)}.`);
    const accts = await accountsById(businessId, [...new Set(p.lines.map((l) => l.account_id))]);
    for (const l of p.lines) {
      const a = accts.get(l.account_id);
      if (!a) throw new ProposalError(`Unknown account ${l.account_id}.`);
      if (a.is_archived) throw new ProposalError(`Account "${a.name}" is archived.`);
    }
    summary = `Journal entry ${p.date}: ${p.memo || "(no memo)"} · ${fmt(dr)}`;
    payload = p;
  } else if (kind === "create_rule") {
    const p = RulePayload.parse(rawPayload);
    const accts = await accountsById(businessId, [p.account_id]);
    const a = requireCategory(accts, p.account_id);
    summary = `Rule: lines containing "${p.pattern.toLowerCase()}" → ${a.name}`;
    payload = { ...p, pattern: p.pattern.toLowerCase() };
  } else if (kind === "create_account") {
    const p = AccountPayload.parse(rawPayload);
    if (p.code) {
      const [dupe] = await sql`select 1 from accounts where business_id = ${businessId} and code = ${p.code}`;
      if (dupe) throw new ProposalError(`Account code ${p.code} is already used.`);
    }
    summary = `New ${p.type} account: ${p.code ? p.code + " · " : ""}${p.name}`;
    payload = p;
  } else {
    throw new ProposalError("Unknown change type");
  }

  const [row] = await sql<{ id: string }[]>`
    insert into proposed_changes (business_id, kind, summary, note, payload, client_name)
    values (${businessId}, ${kind}, ${summary}, ${opts.note ?? ""}, ${sql.json(payload as never)}, ${opts.clientName ?? null})
    returning id`;
  return { id: row.id, summary };
}

export type Proposal = {
  id: string;
  kind: Kind;
  summary: string;
  note: string;
  payload: Record<string, unknown>;
  status: "pending" | "applied" | "rejected" | "failed";
  result: string | null;
  client_name: string | null;
  created_at: Date;
  decided_at: Date | null;
};

export async function listProposals(businessId: string, status?: Proposal["status"] | "decided", limit = 50) {
  const sql = db();
  return sql<Proposal[]>`
    select id, kind, summary, note, payload, status, result, client_name, created_at, decided_at
    from proposed_changes where business_id = ${businessId}
      ${status === "decided" ? sql`and status <> 'pending'` : status ? sql`and status = ${status}` : sql``}
    order by created_at desc limit ${limit}`;
}

/** Apply an approved proposal. Re-validates against the books as they are now. */
export async function applyProposal(businessId: string, id: string): Promise<string> {
  const sql = db();
  const [p] = await sql<Proposal[]>`
    update proposed_changes set status = 'failed', result = 'Applying…'
    where id = ${id} and business_id = ${businessId} and status = 'pending'
    returning id, kind, summary, note, payload, status, result, client_name, created_at, decided_at`;
  if (!p) throw new ProposalError("This change was already decided.");

  let result = "";
  try {
    if (p.kind === "categorize") {
      const pl = CategorizePayload.parse(p.payload);
      const accts = await accountsById(businessId, pl.items.map((i) => i.account_id));
      pl.items.forEach((i) => requireCategory(accts, i.account_id));
      let done = 0;
      const problems: string[] = [];
      for (const it of pl.items) {
        try {
          const [t] = await sql<{ status: string }[]>`
            select status from bank_transactions where id = ${it.transaction_id} and business_id = ${businessId}`;
          if (!t) throw new Error("transaction no longer exists");
          if (t.status !== "review") await L.reopenTransaction(businessId, it.transaction_id);
          await L.postBankTransaction(businessId, it.transaction_id, it.account_id, { remember: pl.remember });
          done++;
        } catch (e) {
          problems.push(`${it.transaction_id.slice(0, 8)}: ${(e as Error).message}`);
        }
      }
      if (pl.remember) await categorizeInbox().catch(() => undefined);
      result = `Posted ${done} of ${pl.items.length}.${problems.length ? " Skipped: " + problems.join("; ") : ""}`;
      if (done === 0) throw new ProposalError(result);
    } else if (p.kind === "exclude") {
      const pl = ExcludePayload.parse(p.payload);
      for (const tid of pl.transaction_ids) await L.excludeTransaction(businessId, tid);
      result = `Excluded ${pl.transaction_ids.length}.`;
    } else if (p.kind === "journal_entry") {
      const pl = JournalPayload.parse(p.payload);
      await sql.begin((q) =>
        L.createEntry(q, {
          businessId,
          date: pl.date,
          memo: pl.memo,
          source: "manual",
          lines: pl.lines.map((l) => ({ accountId: l.account_id, debit: l.debit_cents, credit: l.credit_cents, description: l.description })),
        })
      );
      result = "Entry posted.";
    } else if (p.kind === "create_rule") {
      const pl = RulePayload.parse(p.payload);
      await sql`
        insert into categorization_rules (business_id, pattern, account_id) values (${businessId}, ${pl.pattern}, ${pl.account_id})
        on conflict (business_id, pattern) do update set account_id = excluded.account_id`;
      const c = await categorizeInbox().catch(() => null);
      result = `Rule saved.${c ? ` ${c.rules} inbox line${c.rules === 1 ? "" : "s"} now match a rule.` : ""}`;
    } else if (p.kind === "create_account") {
      const pl = AccountPayload.parse(p.payload);
      await sql`insert into accounts (business_id, code, name, type) values (${businessId}, ${pl.code}, ${pl.name}, ${pl.type})`;
      result = "Account added.";
    }
    await sql`update proposed_changes set status = 'applied', result = ${result}, decided_at = now() where id = ${id}`;
    return result;
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues[0]?.message ?? "Invalid change" : (e as Error).message;
    await sql`update proposed_changes set status = 'failed', result = ${msg}, decided_at = now() where id = ${id}`;
    throw new ProposalError(msg);
  }
}

export async function rejectProposal(businessId: string, id: string) {
  await db()`
    update proposed_changes set status = 'rejected', decided_at = now()
    where id = ${id} and business_id = ${businessId} and status = 'pending'`;
}
