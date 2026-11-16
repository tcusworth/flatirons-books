import { CORS_HEADERS, OAuthError, exchangeToken } from "@/lib/oauth";

async function readForm(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const j = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v)]));
  }
  return Object.fromEntries(new URLSearchParams(await req.text()));
}

function readBasic(req: Request) {
  const m = req.headers.get("authorization")?.match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  const [id, ...rest] = Buffer.from(m[1], "base64").toString("utf8").split(":");
  return { id: decodeURIComponent(id), secret: decodeURIComponent(rest.join(":")) };
}

export async function POST(req: Request) {
  const headers = { ...CORS_HEADERS, "cache-control": "no-store", pragma: "no-cache" };
  try {
    const tokens = await exchangeToken(await readForm(req), readBasic(req));
    return Response.json(tokens, { headers });
  } catch (e) {
    const err = e instanceof OAuthError ? e : new OAuthError("server_error", "Token request failed", 500);
    if (!(e instanceof OAuthError)) console.error(e);
    return Response.json({ error: err.code, error_description: err.message }, { status: err.status, headers });
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
