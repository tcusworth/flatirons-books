# Flatirons Books

Internal AI bookkeeping for Flatirons Creative Studio, modeled on the BooksGPT workflow:
bank lines arrive, each gets a suggested category, you approve, and the double-entry books and reports update.

## What's in v1

- **Double-entry ledger** in Postgres. Every entry must balance, and a database trigger rejects any that don't, even if app code is bypassed.
- **Chart of accounts** seeded for a web/SEO/marketing studio, editable in the app.
- **Bank feeds via Plaid** (`/transactions/sync`, with a webhook plus a daily scheduled sync as backup). Access tokens are encrypted at rest (AES-256-GCM).
- **Statement import**: CSV with column mapping and sign check, or PDF read by Claude. Re-importing the same file never duplicates lines.
- **AI inbox**. Suggestions are made in this order:
  1. **Transfers**: the same amount moving between your own accounts, such as a card payment from checking.
  2. **Your rules**: "Remember" in the inbox, or the Rules page. Confidence 100%.
  3. **Your history**: exact matches to lines you've already categorized.
  4. **Claude**: anything left, with a confidence score and reason.
  Nothing posts until you approve. "Approve all sure ones" posts everything at 90% or above. Undo sends a line back to the inbox.
- **Reports**: profit & loss (total or by month), balance sheet (with retained earnings and current-year net income), and an account register for every account.
- **Manual journal entries** and **opening balances** per bank account.
- **Password sign-in** (one user).

- **AI connector (MCP)**: ask Claude about your books, and let it prepare changes that you approve in the app (see below).

Not in v1: invoicing, bank reconciliation against statements, a QuickBooks import, an in-app Copilot chat, and multiple businesses. The schema already has a `business_id` everywhere, so multiple businesses can be added later.

## Run locally

```bash
npm install
cp .env.example .env.local   # fill in DATABASE_URL, APP_PASSWORD, SESSION_SECRET, ENCRYPTION_KEY
set -a; . ./.env.local; set +a
npm run db:migrate           # creates tables and seeds the business + chart of accounts (safe to re-run)
npm run dev                  # http://localhost:3000
```

Tests run against a **disposable** database, which they wipe first:

```bash
TEST_DATABASE_URL=postgres://.../books_test npm test
```

## Deploy on Netlify

Netlify builds Next.js 16 automatically (OpenNext adapter), so there's no plugin to add. `netlify.toml` runs
`npm run db:migrate` before every build, so the database schema stays current on each deploy.

1. **Database.** Create a free project at neon.com, or use Supabase. Copy the **pooled** connection string.
   Use your own Postgres URL in `DATABASE_URL`, not Netlify Database: that product expects migration files
   applied by Netlify, and this app runs its own migration.
2. **Code.** Push this folder to a private GitHub repo.
3. **Netlify:** Add new project → Import from Git → pick the repo. Netlify reads the build settings from `netlify.toml`.
4. **Environment variables** (Project configuration → Environment variables, scope "All"):

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | Neon pooled connection string |
   | `DB_PREPARE` | `false` (safe with poolers) |
   | `APP_PASSWORD` | your login password |
   | `SESSION_SECRET` | `openssl rand -base64 48` |
   | `ENCRYPTION_KEY` | `openssl rand -base64 32`. **Never change it after connecting a bank.** |
   | `APP_URL` | only if you use a custom domain, e.g. `https://books.fcstudio.us` (otherwise Netlify's `URL` is used) |
   | `CRON_SECRET`, `PLAID_WEBHOOK_SECRET` | long random strings |
   | `ANTHROPIC_API_KEY` | turns on AI categorization and PDF statements |
   | `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | `sandbox` first, then `production` once Plaid approves you |

5. **Deploy.** Then sign in, open **Settings**, and check the status lights.
6. **Connect Claude:** Customize → Connectors → Add custom connector → `https://<your-site>/api/mcp`.

**Netlify specifics**
- **Daily bank sync:** `netlify/functions/daily-bank-sync.ts` is a Scheduled Function (12:17 UTC). It calls `/api/cron/sync`
  with `CRON_SECRET`. It only runs on the production deploy, and you can trigger it from the Functions tab to test.
  The Plaid webhook normally delivers new transactions sooner.
- **Function time limit:** Netlify's synchronous limit is 60 seconds. A long PDF statement can take longer for Claude to read.
  If that happens, import the bank's CSV export instead.
- **Plaid production access** has to be applied for in the Plaid dashboard, and it's priced per connected account.

## AI connector (MCP)

The app is an MCP server at `https://<your app>/api/mcp` (Streamable HTTP, stateless, so it runs on serverless hosts).

**Connect Claude (web, desktop, mobile):** Customize → Connectors → Add custom connector → paste the URL → Add.
Claude opens this app's sign-in page. Enter your app password, then click **Allow**. To disconnect, use **Settings → AI connector**.
Claude Code: `claude mcp add --transport http flatirons-books https://<your app>/api/mcp`, then run `/mcp` to sign in.

**What it can do**

| Read (any time) | Propose (waits on the Approvals page) |
| --- | --- |
| `get_overview`: cash, cards, net income, inbox, pending approvals | `propose_categorization`: post inbox lines or re-categorize posted ones, with an optional "remember" |
| `get_profit_and_loss`: by account, optionally by month | `propose_exclusion`: drop duplicates or personal lines from the inbox |
| `get_balance_sheet` | `propose_journal_entry`: balanced manual entries |
| `list_accounts`: ids, codes, balances | `propose_rule`: a categorization rule |
| `search_transactions`: text, dates, category, amount, with totals | `propose_account`: a new account |
| `get_account_activity`: register with running balance | |
| `list_inbox`, `list_rules`, `list_proposed_changes` | |

Nothing an AI app sends changes your books. Each proposal is validated, then shown on **Approvals** with the lines it would affect. Approve applies it and re-checks it against the books as they are at that moment. Reject discards it. Posted changes can still be undone from Transactions or Journal entries.

**Sign-in details:** this is a small OAuth 2.1 server built into the app. It supports discovery documents, dynamic client registration, client ID metadata documents, PKCE (S256 only), and rotating refresh tokens. Access tokens last 1 hour and refresh tokens 60 days, and both are stored only as hashes. A client can register itself, but it gets nothing until you sign in with your password and click Allow. `MCP_API_KEY` (optional) is a fixed bearer key for scripts.

Tested here with the official MCP SDK client over HTTP against a running build: discovery → registration → browser sign-in and Allow → token → all 14 tools → proposals → approval in the UI → refresh. **Not yet tested against claude.ai itself**, which needs the app deployed at a public https address.

## How the money works

- Amounts are integer cents. Bank lines use Plaid's sign: **positive = money out**.
- Posting a line: money out debits the category and credits the bank/card account. Money in does the reverse. This is correct for both checking (an asset) and credit cards (a liability).
- Reports are cash-basis, since everything comes from bank lines or manual entries.
- The chart of accounts is a starting point, not tax advice. Have your CPA confirm the categories.

## Layout

```
db/schema.sql          tables, balance trigger (idempotent)
scripts/migrate.mjs    applies schema + first-run seed
lib/ledger.ts          posting, transfers, undo, opening balances
lib/categorize.ts      transfer matching, rules, history, Claude
lib/plaid.ts           Link token, token exchange, /transactions/sync
lib/imports.ts         statement import, PDF extraction
lib/csv.ts             CSV column mapping (shared with the browser)
lib/reports.ts         P&L, balance sheet, registers
lib/mcp.ts             MCP tools; app/api/mcp/route.ts serves them
lib/proposals.ts       propose → approve/reject → apply
lib/oauth.ts           OAuth server for connectors (+ app/oauth/authorize, app/api/oauth/*, /.well-known/*)
app/(app)/...          pages; app/(app)/actions.ts holds every server action
app/api/...            Plaid, import, webhook, cron routes
tests/*.test.ts        integration tests against real Postgres (ledger, MCP tools, OAuth)
```
