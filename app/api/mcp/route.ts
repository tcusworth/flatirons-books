import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "@/lib/mcp";
import { CORS_HEADERS, baseUrl, verifyBearer } from "@/lib/oauth";

export const maxDuration = 60;

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Stateless Streamable HTTP: a fresh server + transport per request, so it runs on serverless hosts. */
async function handle(req: Request): Promise<Response> {
  const base = baseUrl(req);
  const who = await verifyBearer(req.headers.get("authorization"));
  if (!who) {
    const hasToken = /^Bearer\s/i.test(req.headers.get("authorization") ?? "");
    // 401 + resource_metadata tells the client where to start OAuth.
    return new Response(JSON.stringify({ error: hasToken ? "invalid_token" : "unauthorized" }), {
      status: 401,
      headers: {
        ...CORS_HEADERS,
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp"${hasToken ? ', error="invalid_token"' : ""}`,
      },
    });
  }
  const server = buildMcpServer({ clientName: who.clientName, appUrl: base });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return withCors(await transport.handleRequest(req));
  } finally {
    // JSON responses are complete once returned; release the per-request server.
    void server.close();
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
