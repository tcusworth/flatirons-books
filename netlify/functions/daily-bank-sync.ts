import type { Config } from "@netlify/functions";

// Netlify Scheduled Function: once a day, ask the app to pull new bank transactions and
// suggest categories. Backup to the Plaid webhook, which normally delivers them sooner.
// Scheduled functions only run on the production deploy, and have a 30-second limit.
export default async () => {
  const env = (k: string) => globalThis.Netlify?.env.get(k) ?? process.env[k];
  const base = (env("APP_URL") || env("URL") || "").replace(/\/$/, "");
  const secret = env("CRON_SECRET");
  if (!base || !secret) {
    console.log("daily-bank-sync skipped: set CRON_SECRET (and APP_URL for a custom domain)");
    return;
  }
  try {
    const res = await fetch(`${base}/api/cron/sync`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(25_000),
    });
    console.log("daily-bank-sync:", res.status, (await res.text()).slice(0, 500));
  } catch (e) {
    console.log("daily-bank-sync failed:", (e as Error).message);
  }
};

// 12:17 UTC is about 5:17am in Boulder.
export const config: Config = { schedule: "17 12 * * *" };
