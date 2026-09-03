/**
 * Bearer-token check for the browser extension's API routes.
 *
 * Phase 2 shortcut: the extension isn't a real per-user Supabase session
 * (that's Phase 5), just a static token pasted from the /settings page. Every
 * extension-facing route calls `requireExtensionToken` first; once it passes,
 * the route uses the *existing* `getDb()`/`getUserId()` helper from
 * `lib/supabase/server.ts` exactly like the website's server actions do, so
 * RLS is still what actually gates the rows — this only gates who's allowed
 * to ask.
 */

function timingSafeEqual(a: string, b: string): boolean {
  // Buffer.byteLength differs from string length for non-ASCII input; tokens
  // are expected to be opaque hex/base64, but pad defensively rather than
  // short-circuit on a length mismatch (which itself leaks length via timing).
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  const length = Math.max(aBytes.length, bBytes.length, 1);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Returns null when the request's bearer token matches EXTENSION_API_TOKEN,
 * or a ready-to-return 401 Response when it doesn't (missing env var counts
 * as misconfigured, not "any token works" — fails closed).
 */
export function requireExtensionToken(request: Request): Response | null {
  const expected = process.env.EXTENSION_API_TOKEN;
  if (!expected) {
    return Response.json(
      { error: "Server is missing EXTENSION_API_TOKEN. Set it in web/.env.local." },
      { status: 500 },
    );
  }

  const auth = request.headers.get("authorization") ?? "";
  const [scheme, token] = auth.split(" ");
  if (scheme !== "Bearer" || !token || !timingSafeEqual(token, expected)) {
    return Response.json({ error: "Missing or invalid bearer token." }, { status: 401 });
  }

  return null;
}
