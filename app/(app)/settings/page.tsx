import { getBusiness } from "@/lib/business";
import { plaidConfigured } from "@/lib/plaid";
import { PageHeader } from "@/components/ui";
import { disconnectApp, saveSettings } from "../actions";
import { connectedApps } from "@/lib/oauth";
import { ActionButton } from "@/components/ActionButton";
import { headers } from "next/headers";

export default async function SettingsPage() {
  const biz = await getBusiness();
  const h = await headers();
  const base = (process.env.APP_URL || process.env.URL)?.replace(/\/$/, "") || `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const apps = await connectedApps();
  const checks: [string, boolean, string][] = [
    ["Database", true, "Connected"],
    ["Plaid bank feeds", plaidConfigured(), `PLAID_ENV=${process.env.PLAID_ENV || "sandbox"}`],
    ["Plaid webhook", Boolean((process.env.APP_URL || process.env.URL) && process.env.PLAID_WEBHOOK_SECRET), "Needs PLAID_WEBHOOK_SECRET"],
    ["AI categorization & PDF reading", Boolean(process.env.ANTHROPIC_API_KEY), `Model: ${process.env.ANTHROPIC_MODEL || "claude-haiku-5-5"}`],
    ["Daily bank sync", Boolean(process.env.CRON_SECRET), "Needs CRON_SECRET"],
    ["AI connector sign-in", Boolean(process.env.APP_URL || process.env.URL), `Issuer ${process.env.APP_URL || process.env.URL || "(set APP_URL)"}`],
  ];
  return (
    <>
      <PageHeader title="Settings" />
      <form action={saveSettings} className="card mb-6 space-y-3 p-4">
        <div>
          <label className="label">Business name</label>
          <input name="name" defaultValue={biz.name} className="input" required />
        </div>
        <div>
          <label className="label">What the business does (the AI reads this when it picks categories)</label>
          <textarea name="description" defaultValue={biz.description} rows={3} className="input" />
        </div>
        <button className="btn-primary">Save</button>
      </form>
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-muted">AI connector (MCP)</h2>
        <div className="card p-4">
          <p className="mb-2 text-sm">
            Add this URL as a custom connector in Claude (Customize → Connectors → Add custom connector). Claude will open a sign-in
            page here; enter your password and click Allow. Claude can then read your books, and any change it prepares waits on Approvals.
          </p>
          <code className="block break-all rounded-md bg-black/[0.04] px-3 py-2 text-[13px]">{base}/api/mcp</code>
        </div>
        <div className="card mt-3 divide-y divide-black/[0.05]">
          {apps.length === 0 && <p className="px-4 py-3 text-sm text-muted">No apps connected.</p>}
          {apps.map((a) => (
            <div key={a.client_id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="flex-1 font-medium">{a.client_name || "Unnamed app"}</span>
              <span className="text-xs text-muted">
                Connected {new Date(a.first_seen).toLocaleDateString("en-US")}
                {a.last_used_at ? ` · last used ${new Date(a.last_used_at).toLocaleString("en-US")}` : ""}
              </span>
              <ActionButton action={disconnectApp.bind(null, a.client_id)} confirm="Disconnect?">Disconnect</ActionButton>
            </div>
          ))}
        </div>
      </section>
      <div className="card divide-y divide-black/[0.05]">
        {checks.map(([label, ok, note]) => (
          <div key={label} className="flex items-center gap-3 px-4 py-2.5">
            <span className={`h-2 w-2 rounded-full ${ok ? "bg-brand-600" : "bg-black/20"}`} />
            <span className="flex-1">{label}</span>
            <span className="text-xs text-muted">{ok ? note : `Off · ${note}`}</span>
          </div>
        ))}
      </div>
    </>
  );
}
