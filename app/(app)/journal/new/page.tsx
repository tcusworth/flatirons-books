import { getBusiness, listAccounts } from "@/lib/business";
import { today } from "@/lib/money";
import { PageHeader } from "@/components/ui";
import { JournalForm } from "./JournalForm";

export default async function NewJournalPage() {
  const biz = await getBusiness();
  const accounts = await listAccounts(biz.id);
  return (
    <>
      <PageHeader title="New journal entry" subtitle="Debits must equal credits. The entry can't be saved until they do." />
      <JournalForm today={today()} accounts={accounts.map((a) => ({ id: a.id, label: `${a.code ? a.code + " · " : ""}${a.name}`, type: a.type }))} />
    </>
  );
}
