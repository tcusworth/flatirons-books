"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getBusiness } from "@/lib/business";
import * as L from "@/lib/ledger";
import { categorizeInbox } from "@/lib/categorize";
import { parseCents, isIsoDate } from "@/lib/money";
import { removeItem, syncAll, syncItem } from "@/lib/plaid";
import { ProposalError } from "@/lib/proposals";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

async function guard<T>(fn: (bizId: string) => Promise<T>): Promise<ActionResult> {
  await requireAuth();
  try {
    const biz = await getBusiness();
    const r = await fn(biz.id);
    return { ok: true, message: typeof r === "string" ? r : undefined };
  } catch (e) {
    if (e instanceof L.LedgerError || (e as Error).name === "ProposalError" || e instanceof ProposalError) return { ok: false, error: (e as Error).message };
    console.error(e);
    return { ok: false, error: (e as Error).message || "Something went wrong" };
  }
}

function refreshAll() {
  revalidatePath("/", "layout");
}

// ---------- Inbox ----------

export async function approveTxn(txnId: string, accountId: string, remember: boolean) {
  const r = await guard((biz) => L.postBankTransaction(biz, txnId, accountId, { remember }));
  if (r.ok && remember) await categorizeInbox().catch(() => undefined);
  refreshAll();
  return r;
}

export async function approveTransfer(outId: string, inId: string) {
  const r = await guard((biz) => L.postTransfer(biz, outId, inId));
  refreshAll();
  return r;
}

export async function rejectTransfer(txnId: string) {
  const r = await guard(async (biz) => {
    const sql = db();
    const [t] = await sql<{ transfer_match_id: string | null }[]>`
      select transfer_match_id from bank_transactions where id = ${txnId} and business_id = ${biz}`;
    const ids = [txnId, t?.transfer_match_id].filter(Boolean) as string[];
    // Flag both lines so the matcher never pairs them again.
    await sql`
      update bank_transactions set transfer_match_id = null, suggestion_source = null, suggestion_confidence = null,
        suggestion_reason = null, not_transfer = true where id in ${sql(ids)} and business_id = ${biz}`;
  });
  await categorizeInbox({}).catch(() => undefined);
  refreshAll();
  return r;
}

export async function excludeTxn(txnId: string) {
  const r = await guard((biz) => L.excludeTransaction(biz, txnId));
  refreshAll();
  return r;
}

export async function reopenTxn(txnId: string) {
  const r = await guard((biz) => L.reopenTransaction(biz, txnId));
  refreshAll();
  return r;
}

export async function approveAllConfident(minConfidence: number) {
  const r = await guard(async (biz) => {
    const sql = db();
    const rows = await sql<{ id: string; suggested_account_id: string }[]>`
      select id, suggested_account_id from bank_transactions
      where business_id = ${biz} and status = 'review' and suggested_account_id is not null
        and transfer_match_id is null and suggestion_confidence >= ${minConfidence}`;
    let n = 0;
    for (const t of rows) {
      await L.postBankTransaction(biz, t.id, t.suggested_account_id);
      n++;
    }
    const pairs = await sql<{ id: string; transfer_match_id: string }[]>`
      select id, transfer_match_id from bank_transactions
      where business_id = ${biz} and status = 'review' and transfer_match_id is not null and amount_cents > 0
        and suggestion_confidence >= ${minConfidence}`;
    for (const p of pairs) {
      await L.postTransfer(biz, p.id, p.transfer_match_id);
      n++;
    }
    return `Approved ${n}`;
  });
  refreshAll();
  return r;
}

export async function runCategorizer(redoAi: boolean) {
  await requireAuth();
  try {
    const r = await categorizeInbox({ redoAi });
    refreshAll();
    const parts = [`${r.transfers} transfers`, `${r.rules} by rule`, `${r.history} from history`, `${r.ai} by AI`];
    return { ok: true, message: parts.join(", ") + (r.aiSkipped ? ". AI skipped: ANTHROPIC_API_KEY is not set." : "") } as ActionResult;
  } catch (e) {
    console.error(e);
    return { ok: false, error: (e as Error).message } as ActionResult;
  }
}

// ---------- Banks ----------

export async function syncNow(itemId?: string) {
  await requireAuth();
  try {
    if (itemId) await syncItem(itemId);
    else await syncAll();
    const c = await categorizeInbox();
    refreshAll();
    return { ok: true, message: `Synced. ${c.transfers + c.rules + c.history + c.ai} suggestions made.` } as ActionResult;
  } catch (e) {
    refreshAll();
    return { ok: false, error: (e as Error).message } as ActionResult;
  }
}

export async function disconnectItem(itemId: string) {
  const r = await guard(() => removeItem(itemId));
  refreshAll();
  return r;
}

export async function addManualBank(formData: FormData) {
  await guard((biz) =>
    L.createManualBankAccount(
      biz,
      String(formData.get("name") ?? "").trim() || "Bank account",
      formData.get("kind") === "credit" ? "credit" : "depository",
      String(formData.get("mask") ?? "").trim() || undefined
    )
  );
  refreshAll();
}

export async function setOpening(formData: FormData) {
  const date = String(formData.get("date") ?? "");
  const cents = parseCents(String(formData.get("balance") ?? ""));
  const bank = String(formData.get("bank_account_id") ?? "");
  if (!isIsoDate(date) || cents === null) redirect("/banks?error=opening");
  await guard((biz) => L.setOpeningBalance(biz, bank, date, cents));
  refreshAll();
}

// ---------- Chart of accounts ----------

export async function addAccount(formData: FormData) {
  await guard(async (biz) => {
    const type = String(formData.get("type"));
    if (!["asset", "liability", "equity", "income", "expense"].includes(type)) throw new L.LedgerError("Pick a type");
    const name = String(formData.get("name") ?? "").trim();
    if (!name) throw new L.LedgerError("Name is required");
    const code = String(formData.get("code") ?? "").trim() || null;
    await db()`insert into accounts (business_id, code, name, type) values (${biz}, ${code}, ${name}, ${type})`;
  });
  refreshAll();
}

export async function renameAccount(formData: FormData) {
  await guard(async (biz) => {
    const id = String(formData.get("id"));
    const name = String(formData.get("name") ?? "").trim();
    const code = String(formData.get("code") ?? "").trim() || null;
    if (!name) throw new L.LedgerError("Name is required");
    await db()`update accounts set name = ${name}, code = ${code} where id = ${id} and business_id = ${biz}`;
  });
  refreshAll();
}

export async function toggleArchive(accountId: string, archived: boolean) {
  const r = await guard(async (biz) => {
    await db()`update accounts set is_archived = ${archived} where id = ${accountId} and business_id = ${biz}
      and subtype is distinct from 'opening_balance' and subtype is distinct from 'retained_earnings'`;
  });
  refreshAll();
  return r;
}

// ---------- Journal ----------

export async function saveJournalEntry(input: {
  date: string;
  memo: string;
  lines: { accountId: string; debit: string; credit: string; description: string }[];
}) {
  return guard(async (biz) => {
    const lines = input.lines.map((l) => {
      const d = parseCents(l.debit) ?? 0;
      const c = parseCents(l.credit) ?? 0;
      if (d < 0 || c < 0) throw new L.LedgerError("Use positive amounts; put money on the debit or credit side");
      return { accountId: l.accountId, debit: d, credit: c, description: l.description };
    });
    await db().begin((q) => L.createEntry(q, { businessId: biz, date: input.date, memo: input.memo.trim(), source: "manual", lines }));
    revalidatePath("/", "layout");
    return "Saved";
  });
}

export async function deleteJournalEntry(entryId: string) {
  const r = await guard((biz) => db().begin((q) => L.deleteEntry(q, biz, entryId)));
  refreshAll();
  return r;
}

// ---------- Rules & settings ----------

export async function deleteRule(ruleId: string) {
  const r = await guard(async (biz) => {
    await db()`delete from categorization_rules where id = ${ruleId} and business_id = ${biz}`;
  });
  refreshAll();
  return r;
}

export async function addRule(formData: FormData) {
  await guard(async (biz) => {
    const pattern = String(formData.get("pattern") ?? "").trim().toLowerCase();
    const accountId = String(formData.get("account_id") ?? "");
    if (pattern.length < 2) throw new L.LedgerError("Pattern is too short");
    await db()`
      insert into categorization_rules (business_id, pattern, account_id) values (${biz}, ${pattern}, ${accountId})
      on conflict (business_id, pattern) do update set account_id = excluded.account_id`;
  });
  await categorizeInbox().catch(() => undefined);
  refreshAll();
}

export async function saveSettings(formData: FormData) {
  await guard(async (biz) => {
    const name = String(formData.get("name") ?? "").trim();
    const description = String(formData.get("description") ?? "").trim();
    if (!name) throw new L.LedgerError("Name is required");
    await db()`update businesses set name = ${name}, description = ${description} where id = ${biz}`;
  });
  refreshAll();
}

// ---------- AI connector: approvals & connected apps ----------

export async function approveProposal(id: string) {
  const { applyProposal } = await import("@/lib/proposals");
  const r = await guard((biz) => applyProposal(biz, id));
  refreshAll();
  return r;
}

export async function rejectProposalAction(id: string) {
  const { rejectProposal } = await import("@/lib/proposals");
  const r = await guard((biz) => rejectProposal(biz, id));
  refreshAll();
  return r;
}

export async function disconnectApp(clientId: string) {
  const { revokeClient } = await import("@/lib/oauth");
  const r = await guard(() => revokeClient(clientId));
  refreshAll();
  return r;
}
