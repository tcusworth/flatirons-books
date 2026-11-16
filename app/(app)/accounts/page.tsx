import Link from "next/link";
import { getBusiness, listAccounts } from "@/lib/business";
import { accountBalances } from "@/lib/reports";
import { Money, PageHeader } from "@/components/ui";
import { ActionButton } from "@/components/ActionButton";
import { addAccount, renameAccount, toggleArchive } from "../actions";

const TYPES = [
  ["asset", "Assets"],
  ["liability", "Liabilities"],
  ["equity", "Equity"],
  ["income", "Income"],
  ["expense", "Expenses"],
] as const;

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const sp = await searchParams;
  const showArchived = sp.archived === "1";
  const biz = await getBusiness();
  const [accounts, balances] = await Promise.all([listAccounts(biz.id, { includeArchived: showArchived }), accountBalances(biz.id)]);
  return (
    <>
      <PageHeader title="Chart of accounts" subtitle="Income and expense accounts are the categories you pick in the inbox.">
        <Link href={showArchived ? "/accounts" : "/accounts?archived=1"} className="btn-ghost">
          {showArchived ? "Hide archived" : "Show archived"}
        </Link>
      </PageHeader>
      <form action={addAccount} className="card mb-6 flex flex-wrap items-end gap-3 p-4">
        <div>
          <label className="label">Code</label>
          <input name="code" placeholder="5130" className="input w-24" />
        </div>
        <div className="min-w-48 flex-1">
          <label className="label">Name</label>
          <input name="name" required placeholder="e.g. Stock Photos & Fonts" className="input" />
        </div>
        <div>
          <label className="label">Type</label>
          <select name="type" className="input" defaultValue="expense">
            {TYPES.map(([v, l]) => <option key={v} value={v}>{l.replace(/s$/, "")}</option>)}
          </select>
        </div>
        <button className="btn-primary">Add account</button>
      </form>
      <div className="space-y-4">
        {TYPES.map(([type, label]) => {
          const list = accounts.filter((a) => a.type === type);
          if (list.length === 0) return null;
          return (
            <div key={type} className="card overflow-hidden">
              <div className="border-b border-black/[0.06] px-4 py-2.5 font-semibold">{label}</div>
              <table className="w-full">
                <tbody className="divide-y divide-black/[0.05]">
                  {list.map((a) => (
                    <tr key={a.id} className={a.is_archived ? "opacity-50" : ""}>
                      <td className="td w-20 text-muted tabular">{a.code}</td>
                      <td className="td">
                        <details>
                          <summary className="cursor-pointer list-none">
                            <Link href={`/accounts/${a.id}`} className="hover:underline">{a.name}</Link>
                            {a.subtype && <span className="ml-2 text-xs text-muted">{a.subtype.replace("_", " ")}</span>}
                            <span className="ml-2 text-xs text-muted hover:text-ink">edit</span>
                          </summary>
                          <form action={renameAccount} className="mt-2 flex flex-wrap gap-2">
                            <input type="hidden" name="id" value={a.id} />
                            <input name="code" defaultValue={a.code ?? ""} className="input w-24" />
                            <input name="name" defaultValue={a.name} className="input w-64" />
                            <button className="btn-secondary">Save</button>
                          </form>
                        </details>
                      </td>
                      <td className="td text-right"><Money cents={balances.get(a.id) ?? 0} /></td>
                      <td className="td w-24 text-right">
                        {a.subtype !== "opening_balance" && a.subtype !== "retained_earnings" && (
                          <ActionButton action={toggleArchive.bind(null, a.id, !a.is_archived)}>
                            {a.is_archived ? "Restore" : "Archive"}
                          </ActionButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </>
  );
}
