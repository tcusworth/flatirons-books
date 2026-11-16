import postgres from "postgres";

// int8 (bigint) columns hold money in cents. Parse them as JS numbers:
// exact up to 2^53 cents (~$90 trillion), far beyond anything this app will see.
// DATE columns come back as 'YYYY-MM-DD' strings so no time-zone shifting can happen.
function makeClient() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return postgres(url, {
    max: Number(process.env.DB_POOL_MAX || 5),
    // Transaction-mode poolers (e.g. Supabase port 6543) need prepared statements off.
    prepare: process.env.DB_PREPARE !== "false",
    onnotice: () => {},
    types: {
      int8num: {
        to: 20,
        from: [20],
        serialize: (x: number) => String(x),
        parse: (x: string) => Number(x),
      },
      plaindate: {
        to: 1082,
        from: [1082],
        serialize: (x: string) => x,
        parse: (x: string) => x,
      },
    },
  });
}

type Client = ReturnType<typeof makeClient>;
const g = globalThis as unknown as { __booksSql?: Client };

/** Shared connection pool (reused across hot reloads in dev). */
export function db(): Client {
  if (!g.__booksSql) g.__booksSql = makeClient();
  return g.__booksSql;
}

/** A query function: the pool or a transaction-scoped client. */
export type Q = Client | postgres.TransactionSql<{ int8num: number; plaindate: string }>;
