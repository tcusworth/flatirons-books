import { redirect } from "next/navigation";
import { checkPassword, isAuthed, startSession } from "@/lib/auth";
import { OAuthError, issueCode, redirectWith, validateAuthorizeRequest } from "@/lib/oauth";
import { Logo } from "@/components/Logo";

export const dynamic = "force-dynamic";

type SP = Record<string, string | undefined>;

function selfUrl(qs: string) {
  // Rebuild from parsed params so this can only ever point back at this page.
  return `/oauth/authorize?${new URLSearchParams(qs).toString()}`;
}

async function signIn(formData: FormData) {
  "use server";
  const qs = String(formData.get("qs") ?? "");
  await new Promise((r) => setTimeout(r, 400));
  if (!checkPassword(String(formData.get("password") ?? ""))) redirect(selfUrl(qs) + "&login_error=1");
  await startSession();
  redirect(selfUrl(qs));
}

async function decide(formData: FormData) {
  "use server";
  const qs = String(formData.get("qs") ?? "");
  if (!(await isAuthed())) redirect(selfUrl(qs));
  const params = Object.fromEntries(new URLSearchParams(qs)) as SP;
  const a = await validateAuthorizeRequest(params); // re-check everything server-side
  if (formData.get("decision") !== "allow") {
    redirect(redirectWith(a.redirectUri, { error: "access_denied", state: a.state }));
  }
  const code = await issueCode(a);
  redirect(redirectWith(a.redirectUri, { code, state: a.state }));
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { login_error, ...oauthParams } = sp;
  const qs = new URLSearchParams(Object.entries(oauthParams).filter((e): e is [string, string] => typeof e[1] === "string")).toString();

  let req;
  let problem: string | null = null;
  try {
    req = await validateAuthorizeRequest(oauthParams);
  } catch (e) {
    problem = e instanceof OAuthError ? e.message : "This connection request couldn't be checked.";
  }

  const authed = await isAuthed();
  const host = req ? new URL(req.redirectUri).host : "";

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="card w-full max-w-md p-7">
        <Logo className="mb-6" />
        {problem ? (
          <>
            <h1 className="mb-2 text-xl font-semibold">Can&apos;t connect</h1>
            <p className="text-sm text-muted">{problem}</p>
          </>
        ) : !authed ? (
          <form action={signIn}>
            <h1 className="mb-1 text-xl font-semibold">Sign in to connect</h1>
            <p className="mb-5 text-sm text-muted">
              <strong className="text-ink">{req!.client.client_name || host}</strong> wants to connect to your books.
            </p>
            <input type="hidden" name="qs" value={qs} />
            <label className="label" htmlFor="password">Password</label>
            <input id="password" name="password" type="password" autoFocus required className="input mb-3" />
            {login_error && <p className="mb-3 text-sm text-red-600">That password didn&apos;t match.</p>}
            <button className="btn-primary w-full py-2">Continue</button>
          </form>
        ) : (
          <form action={decide}>
            <h1 className="mb-1 text-xl font-semibold">Allow {req!.client.client_name || "this app"}?</h1>
            <p className="mb-4 text-sm text-muted">It will send you back to <span className="font-medium text-ink">{host}</span>.</p>
            <ul className="mb-5 space-y-2 text-sm">
              <li className="flex gap-2"><span className="text-brand-600">✓</span> Read your books: reports, accounts, transactions, the inbox</li>
              <li className="flex gap-2"><span className="text-brand-600">✓</span> Prepare changes, which wait on your Approvals page</li>
              <li className="flex gap-2"><span className="text-muted">✕</span> It can&apos;t change your books without your approval in this app</li>
            </ul>
            <p className="mb-5 text-xs text-muted">You can disconnect it any time in Settings.</p>
            <input type="hidden" name="qs" value={qs} />
            <div className="flex gap-2">
              <button name="decision" value="allow" className="btn-primary flex-1 py-2">Allow</button>
              <button name="decision" value="deny" className="btn-secondary flex-1 py-2">Deny</button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
