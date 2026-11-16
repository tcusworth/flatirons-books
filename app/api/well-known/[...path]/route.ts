import { CORS_HEADERS, authorizationServerMetadata, baseUrl, protectedResourceMetadata } from "@/lib/oauth";

// Served at /.well-known/* through a rewrite in next.config.ts.
// Clients may ask for the path-suffixed form (e.g. /.well-known/oauth-protected-resource/api/mcp), so match on the first segment.
export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const base = baseUrl(req);
  const headers = { ...CORS_HEADERS, "cache-control": "public, max-age=300" };
  switch (path[0]) {
    case "oauth-protected-resource":
      return Response.json(protectedResourceMetadata(base), { headers });
    case "oauth-authorization-server":
    case "openid-configuration":
      return Response.json(authorizationServerMetadata(base), { headers });
    default:
      return Response.json({ error: "not_found" }, { status: 404, headers });
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
