import { CORS_HEADERS, revokeToken } from "@/lib/oauth";

// RFC 7009: always 200, whether or not the token existed.
export async function POST(req: Request) {
  const form = new URLSearchParams(await req.text());
  const tok = form.get("token");
  if (tok) await revokeToken(tok);
  return new Response(null, { status: 200, headers: CORS_HEADERS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
