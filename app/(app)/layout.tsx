import { requireAuth, endSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { getBusiness } from "@/lib/business";
import { Logo } from "@/components/Logo";
import { Nav } from "@/components/Nav";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

async function signOut() {
  "use server";
  await endSession();
  redirect("/login");
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireAuth();
  const biz = await getBusiness();
  const [{ n }] = await db()<{ n: number }[]>`
    select count(*)::int8 as n from bank_transactions where business_id = ${biz.id} and status = 'review'`;
  const [{ p }] = await db()<{ p: number }[]>`
    select count(*)::int8 as p from proposed_changes where business_id = ${biz.id} and status = 'pending'`;
  return (
    <div className="mx-auto flex min-h-screen max-w-[1400px] flex-col md:flex-row">
      <aside className="border-b border-black/[0.06] px-4 py-4 md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:border-b-0 md:border-r md:py-6">
        <Logo className="mb-1 px-1" />
        <p className="mb-5 px-1 text-xs text-muted">{biz.name}</p>
        <Nav inboxCount={n} approvalsCount={p} />
        <form action={signOut} className="mt-6 hidden md:block">
          <button className="btn-ghost w-full justify-start px-3">Sign out</button>
        </form>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
    </div>
  );
}
