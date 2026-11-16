// Applies db/schema.sql and seeds the business + chart of accounts the first time.
// Usage: DATABASE_URL=... node scripts/migrate.mjs
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(path.join(here, "..", "db", "schema.sql"), "utf8");

const BUSINESS_NAME = process.env.BUSINESS_NAME || "Flatirons Creative Studio";
const BUSINESS_DESCRIPTION =
  process.env.BUSINESS_DESCRIPTION ||
  "Boulder, CO web design, SEO, AEO and digital marketing studio run by a solo operator. Also builds SaaS products.";

// A starting chart of accounts for a service business. Edit freely in the app.
// [code, name, type, subtype]
const CHART = [
  ["1100", "Accounts Receivable", "asset", null],
  ["1500", "Computer Equipment", "asset", null],
  ["2000", "Accounts Payable", "liability", null],
  ["2200", "Sales Tax Payable", "liability", null],
  ["2500", "Loans Payable", "liability", null],
  ["3000", "Owner's Contributions", "equity", null],
  ["3100", "Owner's Draw", "equity", "owner_draw"],
  ["3900", "Opening Balance Equity", "equity", "opening_balance"],
  ["3950", "Retained Earnings", "equity", "retained_earnings"],
  ["4000", "Web Design Revenue", "income", null],
  ["4010", "SEO & AEO Services Revenue", "income", null],
  ["4020", "Hosting & Maintenance Revenue", "income", null],
  ["4030", "SaaS & Subscription Revenue", "income", null],
  ["4900", "Other Income", "income", null],
  ["4910", "Interest Income", "income", null],
  ["4999", "Uncategorized Income", "income", "uncategorized"],
  ["5000", "Contract Labor", "expense", null],
  ["5100", "Software & Subscriptions", "expense", null],
  ["5110", "Web Hosting & Domains", "expense", null],
  ["5120", "AI & API Services", "expense", null],
  ["5200", "Advertising & Marketing", "expense", null],
  ["5300", "Bank & Payment Processing Fees", "expense", null],
  ["5400", "Office Supplies", "expense", null],
  ["5410", "Computer Equipment (expensed)", "expense", null],
  ["5500", "Legal & Accounting", "expense", null],
  ["5600", "Insurance", "expense", null],
  ["5700", "Meals", "expense", null],
  ["5710", "Travel", "expense", null],
  ["5800", "Phone & Internet", "expense", null],
  ["5900", "Education & Training", "expense", null],
  ["5950", "Dues & Memberships", "expense", null],
  ["6000", "Rent", "expense", null],
  ["6100", "Taxes & Licenses", "expense", null],
  ["6999", "Uncategorized Expense", "expense", "uncategorized"],
];

const sql = postgres(url, { max: 1, onnotice: () => {}, prepare: process.env.DB_PREPARE !== "false" });

try {
  await sql.unsafe(schema);
  const [existing] = await sql`select id from businesses order by created_at limit 1`;
  if (!existing) {
    await sql.begin(async (tx) => {
      const [biz] = await tx`
        insert into businesses (name, description)
        values (${BUSINESS_NAME}, ${BUSINESS_DESCRIPTION}) returning id`;
      for (const [code, name, type, subtype] of CHART) {
        await tx`
          insert into accounts (business_id, code, name, type, subtype)
          values (${biz.id}, ${code}, ${name}, ${type}, ${subtype})`;
      }
    });
    console.log(`Seeded "${BUSINESS_NAME}" with ${CHART.length} accounts.`);
  } else {
    console.log("Schema up to date. Business already exists, seed skipped.");
  }
} finally {
  await sql.end();
}
