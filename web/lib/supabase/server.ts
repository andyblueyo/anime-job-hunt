import { createClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase access for the `anime_jobs` schema.
 *
 * Phase 1 is single-user and has no login UI, but every table has RLS with
 * policies keyed on `auth.uid()` — so an anonymous client sees nothing at all.
 * Instead of weakening RLS or reaching for the service_role key (which must
 * never live in this repo), we sign in as one real Supabase auth user with
 * credentials from `.env.local` and reuse that session's access token.
 *
 * Phase 5 swaps `getSession()` for a cookie-backed session from real auth; the
 * rest of the app only touches `getDb()` / `getUserId()` and won't need to change.
 */

const SCHEMA = "anime_jobs";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy web/.env.local.example to web/.env.local and fill it in.`,
    );
  }
  return value;
}

type Session = { accessToken: string; userId: string; expiresAtMs: number };

// Cached across requests in a single server process. The in-flight promise is
// cached too, so concurrent requests on a cold cache trigger one sign-in.
let sessionPromise: Promise<Session> | null = null;

async function signIn(): Promise<Session> {
  const client = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data, error } = await client.auth.signInWithPassword({
    email: requireEnv("ANIME_JOBS_USER_EMAIL"),
    password: requireEnv("ANIME_JOBS_USER_PASSWORD"),
  });

  if (error || !data.session) {
    throw new Error(
      `Could not sign in as ANIME_JOBS_USER_EMAIL: ${error?.message ?? "no session returned"}. ` +
        `Create this user under Auth -> Users in the Supabase dashboard (and confirm its email).`,
    );
  }

  return {
    accessToken: data.session.access_token,
    userId: data.session.user.id,
    // expires_at is seconds since epoch; fall back to a conservative hour.
    expiresAtMs: (data.session.expires_at ?? Math.floor(Date.now() / 1000) + 3600) * 1000,
  };
}

async function getSession(): Promise<Session> {
  if (sessionPromise) {
    try {
      const session = await sessionPromise;
      // Re-sign-in a minute before expiry rather than racing the deadline.
      if (session.expiresAtMs - Date.now() > 60_000) return session;
    } catch {
      // Fall through and retry; a failed sign-in shouldn't poison the cache.
    }
  }

  sessionPromise = signIn();
  try {
    return await sessionPromise;
  } catch (error) {
    sessionPromise = null;
    throw error;
  }
}

/** A Supabase client scoped to `anime_jobs` and authenticated as the app user. */
export async function getDb() {
  return getDbImpl();
}

/** The `anime_jobs`-scoped client type, for helpers that take `getDb()`'s result as a parameter. */
export type Db = Awaited<ReturnType<typeof getDb>>;

async function getDbImpl() {
  const { accessToken } = await getSession();

  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      db: { schema: SCHEMA },
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    },
  );
}

/** The signed-in user's id, needed on every insert to satisfy RLS. */
export async function getUserId(): Promise<string> {
  return (await getSession()).userId;
}
