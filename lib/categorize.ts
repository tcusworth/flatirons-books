import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import { getBusiness, listAccounts, type Account } from "./business";
import { matchRule, normalizeText, type Rule } from "./rules";

type Pending = {
  id: string;
  bank_account_id: string;
  ledger_account_id: string;
  txn_date: string;
  description: string;
  merchant: string | null;
  amount_cents: number;
  bank_category: string | null;
  bank_name: string;
  not_transfer?: boolean;
};

export type Suggestion = { id: string; account_id: string; confidence: number; reason: string; source: "rule" | "history" | "ai" };

const TRANSFER_WINDOW_DAYS = 5;

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86_400_000;
}

/**
 * Pair money out of one of your accounts with the same amount into another one
 * (checking -> savings, checking -> credit card payment) so it isn't counted as income and expense.
 */
export function findTransferPairs(txns: Pending[]): [string, string][] {
  const ok = txns.filter((t) => !t.not_transfer);
  const outs = ok.filter((t) => t.amount_cents > 0).sort((a, b) => a.txn_date.localeCompare(b.txn_date));
  const ins = ok.filter((t) => t.amount_cents < 0);
  const used = new Set<string>();
  const pairs: [string, string][] = [];
  for (const o of outs) {
    let best: Pending | null = null;
    for (const i of ins) {
      if (used.has(i.id) || i.bank_account_id === o.bank_account_id) continue;
      if (i.amount_cents !== -o.amount_cents) continue;
      const d = daysApart(o.txn_date, i.txn_date);
      if (d > TRANSFER_WINDOW_DAYS) continue;
      if (!best || d < daysApart(o.txn_date, best.txn_date)) best = i;
    }
    if (best) {
      used.add(best.id);
      used.add(o.id);
      pairs.push([o.id, best.id]);
    }
  }
  return pairs;
}

async function suggestWithClaude(
  biz: { name: string; description: string },
  txns: Pending[],
  accounts: Account[],
  examples: { description: string; amount_cents: number; account_name: string }[]
): Promise<Suggestion[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || txns.length === 0) return [];
  const client = new Anthropic({ apiKey });
  const allowed = new Map(accounts.map((a) => [a.id, a]));
  const chart = accounts.map((a) => `${a.id} | ${a.code ?? ""} ${a.name} (${a.type})`).join("\n");
  const exampleText = examples.length
    ? examples.map((e) => `- "${e.description}" ${e.amount_cents > 0 ? "money out" : "money in"} → ${e.account_name}`).join("\n")
    : "(none yet)";
  const results: Suggestion[] = [];

  for (let i = 0; i < txns.length; i += 25) {
    const batch = txns.slice(i, i + 25);
    const lines = batch
      .map(
        (t) =>
          `${t.id} | ${t.txn_date} | ${t.bank_name} | ${t.amount_cents > 0 ? "MONEY OUT" : "MONEY IN"} $${(Math.abs(t.amount_cents) / 100).toFixed(2)} | ${t.merchant ? `merchant: ${t.merchant} | ` : ""}${t.description}${t.bank_category ? ` | bank category: ${t.bank_category}` : ""}`
      )
      .join("\n");
    const msg = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5",
      max_tokens: 4096,
      system:
        `You are the bookkeeper for ${biz.name}: ${biz.description}\n` +
        "Assign each bank transaction to exactly one account from the chart of accounts, using the account id. " +
        "Money out is usually an expense (or owner's draw, loan payment, or asset purchase). Money in is usually income " +
        "(or an owner contribution or loan). Follow the owner's past choices when a transaction looks like one of them. " +
        "Confidence is 0 to 1: use 0.9+ only when the merchant makes the category obvious. " +
        "If you can't tell, use the Uncategorized account with low confidence. Keep each reason under 12 words.",
      tools: [
        {
          name: "record_categories",
          description: "Record the category chosen for each transaction.",
          input_schema: {
            type: "object",
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Transaction id" },
                    account_id: { type: "string", description: "Account id from the chart of accounts" },
                    confidence: { type: "number" },
                    reason: { type: "string" },
                  },
                  required: ["id", "account_id", "confidence", "reason"],
                },
              },
            },
            required: ["results"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "record_categories" },
      messages: [
        {
          role: "user",
          content: `Chart of accounts (id | code name (type)):\n${chart}\n\nPast choices by the owner:\n${exampleText}\n\nTransactions (id | date | account | direction amount | details):\n${lines}`,
        },
      ],
    });
    const block = msg.content.find((c) => c.type === "tool_use");
    const out = (block && block.type === "tool_use" ? (block.input as { results?: unknown }) : {}).results;
    if (!Array.isArray(out)) continue;
    const ids = new Set(batch.map((t) => t.id));
    for (const r of out as Record<string, unknown>[]) {
      const id = String(r.id ?? "");
      const accountId = String(r.account_id ?? "");
      if (!ids.has(id) || !allowed.has(accountId)) continue;
      const conf = Math.max(0, Math.min(1, Number(r.confidence) || 0));
      results.push({ id, account_id: accountId, confidence: conf, reason: String(r.reason ?? "").slice(0, 200), source: "ai" });
    }
  }
  return results;
}

/**
 * Suggest a category for every inbox transaction that doesn't have one yet.
 * Order: transfer pairs, then your saved rules, then your own history, then Claude.
 */
export async function categorizeInbox(opts: { redoAi?: boolean } = {}) {
  const sql = db();
  const biz = await getBusiness();
  const pending = await sql<(Pending & { suggestion_source: string | null })[]>`
    select t.id, t.bank_account_id, b.ledger_account_id, t.txn_date, t.description, t.merchant, t.amount_cents,
           t.bank_category, b.name as bank_name, t.suggestion_source, t.not_transfer
    from bank_transactions t join bank_accounts b on b.id = t.bank_account_id
    where t.business_id = ${biz.id} and t.status = 'review'
    order by t.txn_date`;
  if (pending.length === 0) return { transfers: 0, rules: 0, history: 0, ai: 0, aiSkipped: false };

  // 1. Transfers (recomputed every run across the whole inbox).
  const pairs = findTransferPairs(pending);
  const inPair = new Set(pairs.flat());
  await sql`
    update bank_transactions set transfer_match_id = null,
      suggestion_source = case when suggestion_source = 'transfer' then null else suggestion_source end
    where business_id = ${biz.id} and status = 'review'`;
  for (const [o, i] of pairs) {
    await sql`
      update bank_transactions set transfer_match_id = case id when ${o}::uuid then ${i}::uuid else ${o}::uuid end,
        suggestion_source = 'transfer', suggested_account_id = null, suggestion_confidence = 0.95,
        suggestion_reason = 'Same amount moved between your accounts'
      where id in ${sql([o, i])}`;
  }

  const rest = pending.filter(
    (t) => !inPair.has(t.id) && (t.suggestion_source === null || t.suggestion_source === "transfer" || (opts.redoAi && t.suggestion_source === "ai"))
  );

  // 2. Rules from "Remember this choice".
  const rules = await sql<Rule[]>`select pattern, account_id from categorization_rules where business_id = ${biz.id}`;
  const suggestions: Suggestion[] = [];
  const left: Pending[] = [];
  for (const t of rest) {
    const r = matchRule(rules, t.merchant, t.description);
    if (r) suggestions.push({ id: t.id, account_id: r.account_id, confidence: 1, reason: `Your rule: "${r.pattern}"`, source: "rule" });
    else left.push(t);
  }

  // 3. Exact match on something you've already categorized.
  const history = await sql<{ norm: string; account_id: string; n: number }[]>`
    select lower(coalesce(t.merchant, t.description)) as norm, l.account_id, count(*)::int8 as n
    from bank_transactions t
    join journal_lines l on l.entry_id = t.journal_entry_id
    join bank_accounts b on b.id = t.bank_account_id and l.account_id <> b.ledger_account_id
    where t.business_id = ${biz.id} and t.status = 'posted' and t.suggestion_source is distinct from 'transfer'
    group by 1, 2`;
  const histMap = new Map<string, { account_id: string; n: number }>();
  for (const h of history) {
    const key = normalizeText(h.norm);
    const cur = histMap.get(key);
    if (!cur || h.n > cur.n) histMap.set(key, { account_id: h.account_id, n: h.n });
  }
  const forAi: Pending[] = [];
  for (const t of left) {
    const h = histMap.get(normalizeText(t.merchant ?? t.description));
    if (h) suggestions.push({ id: t.id, account_id: h.account_id, confidence: 0.95, reason: `Matches ${h.n} earlier transaction${h.n > 1 ? "s" : ""}`, source: "history" });
    else forAi.push(t);
  }

  // 4. Claude for the rest.
  let aiSkipped = false;
  if (forAi.length) {
    if (!process.env.ANTHROPIC_API_KEY) aiSkipped = true;
    else {
      const accounts = (await listAccounts(biz.id)).filter((a) => a.subtype !== "bank" && a.subtype !== "credit_card" && a.subtype !== "opening_balance");
      const examples = await sql<{ description: string; amount_cents: number; account_name: string }[]>`
        select coalesce(t.merchant, t.description) as description, t.amount_cents, a.name as account_name
        from bank_transactions t
        join journal_lines l on l.entry_id = t.journal_entry_id
        join bank_accounts b on b.id = t.bank_account_id and l.account_id <> b.ledger_account_id
        join accounts a on a.id = l.account_id
        where t.business_id = ${biz.id} and t.status = 'posted'
        order by t.txn_date desc limit 60`;
      suggestions.push(...(await suggestWithClaude(biz, forAi, accounts, examples)));
    }
  }

  for (const s of suggestions) {
    await sql`
      update bank_transactions set suggested_account_id = ${s.account_id}, suggestion_confidence = ${s.confidence},
        suggestion_reason = ${s.reason}, suggestion_source = ${s.source}
      where id = ${s.id} and status = 'review'`;
  }
  const count = (src: string) => suggestions.filter((s) => s.source === src).length;
  return { transfers: pairs.length, rules: count("rule"), history: count("history"), ai: count("ai"), aiSkipped };
}
