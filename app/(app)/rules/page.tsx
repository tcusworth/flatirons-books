import { db } from "@/lib/db";
import { getBusiness, listAccounts } from "@/lib/business";
import { PageHeader, Empty } from "@/components/ui";
import { ActionButton } from "@/components/ActionButton";
import { addRule, deleteRule } from "../actions";

export default async function RulesPage() {
  const biz = await getBusiness();
  const rules = await db()<{ id: string; pattern: string; account: string; created_at: Date }[]>`
    select r.id, r.pattern, a.name as account, r.created_at from categorization_rules r join accounts a on a.id = r.account_id
    where r.business_id = ${biz.id} order by r.pattern`;
  const accounts = (await listAccounts(biz.id)).filter((a) => a.subtype !== "bank" && a.subtype !== "credit_card");
  return (
    <>
      <PageHeader
        title="Rules"
        subtitle="When a bank line contains the words, it gets the category at 100% confidence. Ticking Remember in the inbox adds one."
      />
      <form action={addRule} className="card mb-6 flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-48 flex-1">
          <label className="label">When the description contains</label>
          <input name="pattern" required placeholder="e.g. adobe" className="input" />
        </div>
        <div>
          <label className="label">Categorize as</label>
          <select name="account_id" className="input" required>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.code ? `${a.code} · ` : ""}{a.name}</option>)}
          </select>
        </div>
        <button className="btn-primary">Add rule</button>
      </form>
      {rules.length === 0 ? (
        <Empty title="No rules yet" />
      ) : (
        <div className="card divide-y divide-black/[0.05]">
          {rules.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-4 py-2.5">
              <code className="rounded bg-black/[0.04] px-1.5 py-0.5 text-[13px]">{r.pattern}</code>
              <span className="text-muted">→</span>
              <span className="flex-1">{r.account}</span>
              <ActionButton action={deleteRule.bind(null, r.id)}>Delete</ActionButton>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
