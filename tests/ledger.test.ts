// Integration tests against a real, throwaway Postgres database.
// Run: TEST_DATABASE_URL=postgres://... npm test   (the database is wiped first)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import postgres from "postgres";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("Set TEST_DATABASE_URL to a disposable database");
process.env.DATABASE_URL = url;

const { db } = await import("../lib/db");
const { getBusiness, listAccounts } = await import("../lib/business");
const L = await import("../lib/ledger");
const R = await import("../lib/reports");
const { categorizeInbox, findTransferPairs } = await import("../lib/categorize");
const { importRows } = await import("../lib/imports");
const { mapCsv, guessMapping } = await import("../lib/csv");
const { parseCents, parseDate } = await import("../lib/money");
const { matchRule, rulePatternFor } = await import("../lib/rules");

let bizId = "";
let acct: Record<string, string> = {};
let checking = "";
let card = "";

before(async () => {
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe("drop schema public cascade; create schema public;");
  await admin.end();
  execFileSync("node", ["scripts/migrate.mjs"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  const biz = await getBusiness();
  bizId = biz.id;
  acct = Object.fromEntries((await listAccounts(bizId)).map((a) => [a.code ?? a.name, a.id]));
  checking = await L.createManualBankAccount(bizId, "Mercury Checking", "depository", "1234");
  card = await L.createManualBankAccount(bizId, "Amex Business", "credit", "9999");
  delete process.env.ANTHROPIC_API_KEY;
});

after(async () => {
  await db().end();
});

test("money and date parsing", () => {
  assert.equal(parseCents("$1,234.56"), 123456);
  assert.equal(parseCents("(12.00)"), -1200);
  assert.equal(parseCents("-5"), -500);
  assert.equal(parseCents("0.105"), 11);
  assert.equal(parseCents("abc"), null);
  assert.equal(parseDate("03/07/2026"), "2026-03-07");
  assert.equal(parseDate("3/7/26"), "2026-03-07");
  assert.equal(parseDate("2026-02-30"), null);
});

test("unbalanced entries are rejected", async () => {
  await assert.rejects(
    db().begin((q) =>
      L.createEntry(q, {
        businessId: bizId, date: "2026-01-02", memo: "bad", source: "manual",
        lines: [{ accountId: acct["5100"], debit: 100 }, { accountId: acct["3000"], credit: 99 }],
      })
    ),
    /must be equal/
  );
  // The database trigger is the last line of defence even if app code is bypassed.
  await assert.rejects(
    db().begin(async (q) => {
      const [e] = await q`insert into journal_entries (business_id, entry_date) values (${bizId}, '2026-01-02') returning id`;
      await q`insert into journal_lines (entry_id, account_id, debit_cents) values (${e.id}, ${acct["5100"]}, 100)`;
      await q`insert into journal_lines (entry_id, account_id, credit_cents) values (${e.id}, ${acct["3000"]}, 50)`;
    }),
    /out of balance|at least two lines/
  );
});

test("CSV mapping, import and dedupe", async () => {
  const records = [
    { Date: "01/05/2026", Description: "STRIPE TRANSFER ST-ABC123", Amount: "2,500.00" },
    { Date: "01/06/2026", Description: "GITHUB *PRO", Amount: "-4.00" },
    { Date: "01/07/2026", Description: "AMEX EPAYMENT ACH PMT", Amount: "-300.00" },
    { Date: "01/09/2026", Description: "GOOGLE *WORKSPACE", Amount: "-14.40" },
    { Date: "", Description: "", Amount: "" },
  ];
  const m = guessMapping(Object.keys(records[0]));
  assert.equal(m.amount, "Amount");
  const { rows, errors } = mapCsv(records, m);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].amountCents, -250000, "deposit is money in (negative)");
  const first = await importRows(bizId, checking, rows, "csv");
  assert.deepEqual(first, { inserted: 4, skipped: 0 });
  const again = await importRows(bizId, checking, rows, "csv");
  assert.deepEqual(again, { inserted: 0, skipped: 4 });

  const cardRows = mapCsv(
    [
      { "Transaction Date": "2026-01-08", Payee: "PAYMENT RECEIVED - THANK YOU", Debit: "", Credit: "300.00" },
      { "Transaction Date": "2026-01-10", Payee: "OPENAI *CHATGPT SUBSCR", Debit: "20.00", Credit: "" },
      { "Transaction Date": "2026-01-12", Payee: "GOOGLE *WORKSPACE", Debit: "14.40", Credit: "" },
    ],
    guessMapping(["Transaction Date", "Payee", "Debit", "Credit"])
  );
  assert.equal(cardRows.rows[0].amountCents, -30000);
  assert.equal(cardRows.rows[1].amountCents, 2000);
  await importRows(bizId, card, cardRows.rows, "csv");
});

test("rules match the longest pattern", () => {
  const rules = [
    { pattern: "amazon", account_id: "a" },
    { pattern: "amazon web services", account_id: "b" },
  ];
  assert.equal(matchRule(rules, null, "AMAZON WEB SERVICES AWS.AMAZON.CO")?.account_id, "b");
  assert.equal(matchRule(rules, null, "AMAZON MKTPL*123")?.account_id, "a");
  assert.equal(rulePatternFor(null, "GITHUB *PRO 12345"), "github pro");
});

test("transfer pairs: card payment from checking", () => {
  const base = { ledger_account_id: "", description: "", merchant: null, bank_category: null, bank_name: "" };
  const pairs = findTransferPairs([
    { ...base, id: "out", bank_account_id: "chk", txn_date: "2026-01-07", amount_cents: 30000 },
    { ...base, id: "in", bank_account_id: "card", txn_date: "2026-01-08", amount_cents: -30000 },
    { ...base, id: "noise", bank_account_id: "chk", txn_date: "2026-01-08", amount_cents: -30000 },
  ]);
  assert.deepEqual(pairs, [["out", "in"]]);
});

test("inbox: categorize, post, remember, transfer, report, undo", async () => {
  const sql = db();
  // Without an API key: transfers + rules + history only.
  let res = await categorizeInbox();
  assert.equal(res.transfers, 1);
  assert.equal(res.aiSkipped, true);

  const byDesc = async (d: string, bank = checking) => {
    const [t] = await sql<{ id: string; transfer_match_id: string | null; amount_cents: number }[]>`
      select id, transfer_match_id, amount_cents from bank_transactions where description = ${d} and bank_account_id = ${bank}`;
    return t;
  };

  // Approve the transfer pair (checking -> Amex payment).
  const pay = await byDesc("AMEX EPAYMENT ACH PMT");
  assert.ok(pay.transfer_match_id);
  await L.postTransfer(bizId, pay.id, pay.transfer_match_id!);

  // Categorize Google on checking and remember it; the card's Google charge should then follow the rule.
  const g = await byDesc("GOOGLE *WORKSPACE");
  await L.postBankTransaction(bizId, g.id, acct["5100"], { remember: true });
  res = await categorizeInbox();
  const [cardGoogle] = await sql<{ suggested_account_id: string; suggestion_source: string }[]>`
    select suggested_account_id, suggestion_source from bank_transactions
    where bank_account_id = ${card} and description = 'GOOGLE *WORKSPACE'`;
  assert.equal(cardGoogle.suggestion_source, "rule");
  assert.equal(cardGoogle.suggested_account_id, acct["5100"]);

  // Post the rest.
  await L.postBankTransaction(bizId, (await byDesc("STRIPE TRANSFER ST-ABC123")).id, acct["4000"]);
  await L.postBankTransaction(bizId, (await byDesc("GITHUB *PRO")).id, acct["5100"]);
  const cardG = await byDesc("GOOGLE *WORKSPACE", card);
  await L.postBankTransaction(bizId, cardG.id, acct["5100"]);
  const ai = await byDesc("OPENAI *CHATGPT SUBSCR", card);
  await L.postBankTransaction(bizId, ai.id, acct["5120"]);

  // Opening balance on checking: $1,000.00 the day before the first line.
  await L.setOpeningBalance(bizId, checking, "2026-01-04", 100000);

  const pl = await R.profitAndLoss(bizId, "2026-01-01", "2026-01-31");
  assert.equal(pl.totalIncome, 250000);
  assert.equal(pl.totalExpense, 400 + 1440 + 1440 + 2000);
  assert.equal(pl.net, 250000 - 5280);

  const bs = await R.balanceSheet(bizId, "2026-01-31");
  assert.equal(bs.balanced, true, "assets = liabilities + equity");
  const bal = await R.accountBalances(bizId);
  const [chkLedger] = await sql<{ ledger_account_id: string }[]>`select ledger_account_id from bank_accounts where id = ${checking}`;
  const [cardLedger] = await sql<{ ledger_account_id: string }[]>`select ledger_account_id from bank_accounts where id = ${card}`;
  // 1000 + 2500 - 4 - 300 - 14.40 = 3181.60
  assert.equal(bal.get(chkLedger.ledger_account_id), 318160);
  // Card owed: 20 + 14.40 - 300 payment = -265.60 (a credit balance on the card)
  assert.equal(bal.get(cardLedger.ledger_account_id), -26560);

  const byMonth = await R.profitAndLossByMonth(bizId, "2026-01-01", "2026-02-28");
  assert.deepEqual(byMonth.months, ["2026-01", "2026-02"]);

  // Undo the transfer: both sides go back to the inbox and the entry is gone.
  await L.reopenTransaction(bizId, pay.id);
  const back = await sql`select status from bank_transactions where id in ${sql([pay.id, pay.transfer_match_id!])}`;
  assert.deepEqual(back.map((b) => b.status), ["review", "review"]);
  const bs2 = await R.balanceSheet(bizId, "2026-01-31");
  assert.equal(bs2.balanced, true);

  // Exclude one, then reopen it.
  await L.excludeTransaction(bizId, pay.id);
  await L.reopenTransaction(bizId, pay.id);
  const [p] = await sql`select status from bank_transactions where id = ${pay.id}`;
  assert.equal(p.status, "review");

  const reg = await R.accountRegister(bizId, chkLedger.ledger_account_id, "2026-01-01", "2026-01-31");
  assert.equal(reg?.closing, 318160 + 30000);
});

test("transactions list includes manual journal lines on income/expense accounts", async () => {
  const { listTransactionRows } = await import("../lib/transactions");
  await db().begin((q) =>
    L.createEntry(q, {
      businessId: bizId, date: "2026-03-31", memo: "Software paid personally — March", source: "manual",
      lines: [
        { accountId: acct["5100"], debit: 2104, description: "2026-03-14 Zoom" },
        { accountId: acct["5110"], debit: 1081, description: "Porkbun domain" },
        { accountId: acct["3000"], credit: 3185, description: "Paid personally by owner" },
      ],
    })
  );
  const rows = await listTransactionRows(bizId, "posted", "");
  const j = rows.filter((r) => r.kind === "journal");
  assert.equal(j.length, 2, "owner's-contribution (equity) line is not listed");
  const zoom = j.find((r) => r.title === "Zoom")!;
  assert.equal(zoom.txn_date, "2026-03-14", "date taken from the line description");
  assert.equal(Number(zoom.display_cents), -2104, "expense shows as money out");
  const pork = j.find((r) => r.title === "Porkbun domain")!;
  assert.equal(pork.txn_date, "2026-03-31", "falls back to the entry date");
  assert.ok(rows.some((r) => r.kind === "bank"), "bank lines still listed");
  assert.equal((await listTransactionRows(bizId, "posted", "zoom")).filter((r) => r.kind === "journal").length, 1);
  assert.equal((await listTransactionRows(bizId, "excluded", "")).filter((r) => r.kind === "journal").length, 0);
});
