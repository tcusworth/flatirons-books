// MCP tools, approvals and OAuth logic against a real, throwaway Postgres database.
// Run: TEST_DATABASE_URL=postgres://... npm test   (the database is wiped first)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("Set TEST_DATABASE_URL to a disposable database");
process.env.DATABASE_URL = url;
process.env.APP_URL = "https://books.test";

const { db } = await import("../lib/db");
const { getBusiness, listAccounts } = await import("../lib/business");
const L = await import("../lib/ledger");
const { importRows } = await import("../lib/imports");
const { buildMcpServer } = await import("../lib/mcp");
const P = await import("../lib/proposals");
const O = await import("../lib/oauth");

let bizId = "";
let acct: Record<string, string> = {};
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  const text = r.content[0].text;
  return { isError: Boolean(r.isError), text, data: r.isError ? null : JSON.parse(text) };
}

before(async () => {
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe("drop schema public cascade; create schema public;");
  await admin.end();
  execFileSync("node", ["scripts/migrate.mjs"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  delete process.env.ANTHROPIC_API_KEY;
  bizId = (await getBusiness()).id;
  acct = Object.fromEntries((await listAccounts(bizId)).map((a) => [a.code ?? a.name, a.id]));
  const chk = await L.createManualBankAccount(bizId, "Mercury Checking", "depository");
  await L.setOpeningBalance(bizId, chk, "2026-01-01", 500000);
  await importRows(
    bizId,
    chk,
    [
      { date: "2026-01-05", description: "STRIPE PAYOUT", amountCents: -300000 },
      { date: "2026-01-06", description: "ADOBE CREATIVE CLOUD", amountCents: 5999 },
      { date: "2026-01-07", description: "FIGMA", amountCents: 1500 },
      { date: "2026-01-08", description: "DUPLICATE CHARGE", amountCents: 1500 },
    ],
    "csv"
  );

  const server = buildMcpServer({ clientName: "Test client", appUrl: "https://books.test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);
});

after(async () => {
  await client.close();
  await db().end();
});

test("lists the expected tools with read-only hints", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "get_account_activity", "get_balance_sheet", "get_overview", "get_profit_and_loss", "list_accounts", "list_inbox",
    "list_proposed_changes", "list_rules", "propose_account", "propose_categorization", "propose_exclusion",
    "propose_journal_entry", "propose_rule", "search_transactions",
  ]);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, !t.name.startsWith("propose_"), t.name);
  }
});

test("read tools answer from the books", async () => {
  const ov = await call("get_overview");
  assert.equal(ov.data.inbox_transactions_to_review, 4);
  assert.equal(ov.data.accounts[0].books_balance, 5000);

  const inbox = await call("list_inbox");
  assert.equal(inbox.data.length, 4);
  const stripe = inbox.data.find((t: { description: string }) => t.description === "STRIPE PAYOUT");
  assert.equal(stripe.amount, 3000, "money in is positive");

  const accts = await call("list_accounts", { type: "income" });
  assert.ok(accts.data.every((a: { type: string }) => a.type === "income"));

  const bad = await call("get_profit_and_loss", { from: "2026-13-01" });
  assert.equal(bad.isError, true);
});

test("propose tools only queue; approval applies", async () => {
  const inbox = (await call("list_inbox")).data as { id: string; description: string }[];
  const id = (d: string) => inbox.find((t) => t.description === d)!.id;

  // Bank account can't be a category.
  const [bank] = await db()`select ledger_account_id from bank_accounts limit 1`;
  const refused = await call("propose_categorization", { items: [{ transaction_id: id("FIGMA"), account_id: bank.ledger_account_id }] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /bank or card account/);

  const prop = await call("propose_categorization", {
    items: [
      { transaction_id: id("STRIPE PAYOUT"), account_id: acct["4000"] },
      { transaction_id: id("ADOBE CREATIVE CLOUD"), account_id: acct["5100"] },
      { transaction_id: id("FIGMA"), account_id: acct["5100"] },
    ],
    remember: true,
    note: "Obvious vendors",
  });
  assert.equal(prop.data.status, "waiting_for_approval");
  assert.equal(prop.data.approve_at, "https://books.test/approvals");

  // Nothing posted yet.
  let pl = await call("get_profit_and_loss", { from: "2026-01-01", to: "2026-01-31" });
  assert.equal(pl.data.net_income, 0);

  const excl = await call("propose_exclusion", { transaction_ids: [id("DUPLICATE CHARGE")] });
  const unbalanced = await call("propose_journal_entry", {
    date: "2026-01-31", memo: "x",
    lines: [{ account_id: acct["5100"], debit: 10 }, { account_id: acct["3000"], credit: 9 }],
  });
  assert.equal(unbalanced.isError, true);
  assert.match(unbalanced.text, /Out of balance/);
  const je = await call("propose_journal_entry", {
    date: "2026-01-31", memo: "Owner put in cash",
    lines: [{ account_id: bank.ledger_account_id, debit: 1000 }, { account_id: acct["3000"], credit: 1000 }],
  });
  const rule = await call("propose_rule", { pattern: "Canva", account_id: acct["5100"] });
  const newAcct = await call("propose_account", { name: "Stock Photos", type: "expense", code: "5130" });
  const dupeCode = await call("propose_account", { name: "Clash", type: "expense", code: "5100" });
  assert.equal(dupeCode.isError, true);

  const pending = await call("list_proposed_changes", { status: "pending" });
  assert.equal(pending.data.length, 5);

  for (const p of [prop, excl, je, rule, newAcct]) await P.applyProposal(bizId, p.data.proposal_id);
  await assert.rejects(P.applyProposal(bizId, prop.data.proposal_id), /already decided/);

  pl = await call("get_profit_and_loss", { from: "2026-01-01", to: "2026-01-31" });
  assert.equal(pl.data.total_income, 3000);
  assert.equal(pl.data.total_expenses, 74.99);
  const bs = await call("get_balance_sheet", { as_of: "2026-01-31" });
  assert.equal(bs.data.balanced, true);
  const rules = await call("list_rules");
  assert.deepEqual(rules.data.map((r: { pattern: string }) => r.pattern).sort(), ["adobe creative cloud", "canva", "figma", "stripe payout"]);
  assert.equal((await call("get_overview")).data.inbox_transactions_to_review, 0);

  // Re-categorize something already posted.
  const figma = (await call("search_transactions", { query: "figma" })).data;
  assert.equal(figma.matches, 1);
  assert.equal(figma.total_money_out, 15);
  const recat = await call("propose_categorization", { items: [{ transaction_id: figma.transactions[0].id, account_id: acct["5120"] }] });
  assert.match(recat.data.summary, /re-categorized/);
  await P.applyProposal(bizId, recat.data.proposal_id);
  const after = (await call("search_transactions", { category_account_id: acct["5120"] })).data;
  assert.equal(after.matches, 1);

  // Rejected proposals change nothing.
  const r2 = await call("propose_account", { name: "Never", type: "expense" });
  await P.rejectProposal(bizId, r2.data.proposal_id);
  const [none] = await db()`select count(*)::int as n from accounts where name = 'Never'`;
  assert.equal(none.n, 0);
});

test("OAuth: registration, PKCE code exchange, refresh rotation, bearer check", async () => {
  await assert.rejects(O.registerClient({ redirect_uris: ["http://evil.example/cb"] }), /redirect_uris/);
  const reg = await O.registerClient({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
  assert.equal(reg.token_endpoint_auth_method, "none");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = {
    response_type: "code", client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: challenge, code_challenge_method: "S256", state: "xyz",
  };
  await assert.rejects(O.validateAuthorizeRequest({ ...q, redirect_uri: "https://evil.example/cb" }), /redirect_uri/);
  await assert.rejects(O.validateAuthorizeRequest({ ...q, code_challenge_method: "plain" }), /PKCE/);
  const a = await O.validateAuthorizeRequest(q);
  const code = await O.issueCode(a);

  await assert.rejects(O.exchangeToken({ grant_type: "authorization_code", code, client_id: reg.client_id, code_verifier: "wrong".repeat(10) }, null), /PKCE/);
  // A failed attempt burns the code (one use only).
  const code2 = await O.issueCode(a);
  const tok = await O.exchangeToken({ grant_type: "authorization_code", code: code2, client_id: reg.client_id, code_verifier: verifier, redirect_uri: q.redirect_uri }, null);
  assert.equal(tok.token_type, "Bearer");
  await assert.rejects(O.exchangeToken({ grant_type: "authorization_code", code: code2, client_id: reg.client_id, code_verifier: verifier }, null), /already used/);

  assert.deepEqual(await O.verifyBearer(`Bearer ${tok.access_token}`), { clientId: reg.client_id, clientName: "Claude" });
  assert.equal(await O.verifyBearer("Bearer nope"), null);
  assert.equal(await O.verifyBearer(null), null);

  const tok2 = await O.exchangeToken({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id }, null);
  assert.notEqual(tok2.access_token, tok.access_token);
  await assert.rejects(O.exchangeToken({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id }, null), /invalid or expired/);

  // Confidential client must send its secret.
  const conf = await O.registerClient({ redirect_uris: ["https://x.example/cb"], token_endpoint_auth_method: "client_secret_post" });
  assert.ok("client_secret" in conf);
  await assert.rejects(O.exchangeToken({ grant_type: "refresh_token", refresh_token: "x", client_id: conf.client_id }, null), /Client authentication failed/);

  await O.revokeClient(reg.client_id);
  assert.equal(await O.verifyBearer(`Bearer ${tok2.access_token}`), null);

  process.env.MCP_API_KEY = "k".repeat(40);
  assert.deepEqual(await O.verifyBearer(`Bearer ${"k".repeat(40)}`), { clientId: "api-key", clientName: "API key" });
  delete process.env.MCP_API_KEY;
});
