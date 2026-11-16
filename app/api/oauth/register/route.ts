import { CORS_HEADERS, OAuthError, registerClient } from "@/lib/oauth";

// Dynamic Client Registration (RFC 7591). Registering grants nothing by itself:
// every authorization still needs the owner's password and an explicit "Allow".
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new OAuthError("invalid_client_metadata", "Expected a JSON body");
    return Response.json(await registerClient(body), { status: 201, headers: CORS_HEADERS });
  } catch (e) {
    const err = e instanceof OAuthError ? e : new OAuthError("server_error", "Registration failed", 500);
    return Response.json({ error: err.code, error_description: err.message }, { status: err.status, headers: CORS_HEADERS });
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
