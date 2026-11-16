import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { hmac, safeEqual } from "./crypto";

// Single-user password login for an internal tool.
const COOKIE = "fb_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (at least 32 characters)");
  return s;
}

export function checkPassword(input: string): boolean {
  const pw = process.env.APP_PASSWORD;
  if (!pw) throw new Error("APP_PASSWORD is not set");
  return safeEqual(input, pw);
}

export function makeSessionToken(now = Date.now()): string {
  const exp = String(Math.floor(now / 1000) + MAX_AGE_SECONDS);
  return `${exp}.${hmac(exp, secret())}`;
}

export function verifySessionToken(token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig) return false;
  if (!safeEqual(sig, hmac(exp, secret()))) return false;
  return Number(exp) > Math.floor(now / 1000);
}

export async function startSession(): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, makeSessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

export async function isAuthed(): Promise<boolean> {
  const jar = await cookies();
  return verifySessionToken(jar.get(COOKIE)?.value);
}

/** Call at the top of every page, server action and route handler that touches the books. */
export async function requireAuth(): Promise<void> {
  if (!(await isAuthed())) redirect("/login");
}

/** For API routes: returns a 401 Response when not signed in, otherwise null. */
export async function apiAuth(): Promise<Response | null> {
  return (await isAuthed()) ? null : Response.json({ error: "Not signed in" }, { status: 401 });
}
