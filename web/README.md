# Next Ep. Lock — website

The Next.js half of [anime-job-hunt](../CLAUDE.md). Phase 1: postings queue and a
bare-bones dashboard, reading and writing the `anime_jobs` schema in Supabase.

## Local setup

```bash
cp .env.local.example .env.local   # then fill it in
npm install
npm run dev                        # http://localhost:3000
```

### Why there are credentials in `.env.local`

Every `anime_jobs` table has RLS with policies keyed on `auth.uid()`, so an
anonymous client sees **zero rows** — RLS isn't optional-until-phase-5. Rather
than loosening the policies or using the `service_role` key (which must never
enter this repo), phase 1 signs in as one real Supabase auth user:

1. Supabase dashboard → **Authentication → Users → Add user**. Set an email and
   password, and tick *Auto Confirm User* (an unconfirmed user can't sign in).
2. Put that email/password in `.env.local` as `ANIME_JOBS_USER_EMAIL` /
   `ANIME_JOBS_USER_PASSWORD`.

`lib/supabase/server.ts` signs in once per server process, caches the access
token, and hands out a client scoped to the `anime_jobs` schema. Phase 5 swaps
that one function for a cookie-backed session from real login; nothing else in
the app touches auth.

### Required grants

`anime_jobs` also needs `../migrations/20260903_grant_anime_jobs_api_access.sql`
applied. Creating a schema by hand grants nothing to PostgREST's roles, so
without it every query fails with `42501 permission denied for schema
anime_jobs` — which looks like a config problem but isn't. Two ways to tell the
failure modes apart:

| Error | Meaning |
| --- | --- |
| `PGRST106 Invalid schema` | schema isn't in Settings → API → *Exposed schemas* |
| `42501 permission denied` | schema is exposed, but the grants migration hasn't run |

## Layout

| Path | What's there |
| --- | --- |
| `app/page.tsx` | Dashboard — stat tiles, lock status, recent applications |
| `app/queue/page.tsx` | Postings queue — status filters, manual add, row actions |
| `app/actions.ts` | Server Actions for every mutation |
| `lib/supabase/server.ts` | Authenticated, schema-scoped Supabase client |
| `lib/types.ts` | Row types for `anime_jobs` (mirrors the migration) |
| `app/globals.css` | The design system — colors, cards, pills, badges |

Both pages are `force-dynamic`: they read live data on every request and must
never be prerendered.

## Deploying

Vercel, with **Root Directory** set to `web`.
