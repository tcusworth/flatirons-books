import { redirect } from "next/navigation";
import { checkPassword, isAuthed, startSession } from "@/lib/auth";
import { Logo } from "@/components/Logo";

async function login(formData: FormData) {
  "use server";
  const pw = String(formData.get("password") ?? "");
  // Small fixed delay blunts password guessing.
  await new Promise((r) => setTimeout(r, 400));
  if (!checkPassword(pw)) redirect("/login?error=1");
  await startSession();
  redirect("/");
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await isAuthed()) redirect("/");
  const { error } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form action={login} className="card w-full max-w-sm p-7">
        <Logo className="mb-6" />
        <h1 className="mb-1 text-xl font-semibold">Sign in</h1>
        <p className="mb-5 text-sm text-muted">Internal books for Flatirons Creative Studio.</p>
        <label className="label" htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoFocus required className="input mb-3" />
        {error && <p className="mb-3 text-sm text-red-600">That password didn&apos;t match.</p>}
        <button className="btn-primary w-full py-2">Sign in</button>
      </form>
    </main>
  );
}
