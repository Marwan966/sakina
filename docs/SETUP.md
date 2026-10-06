# Deployment and database setup

## Credentials

Use separate, randomly generated credentials and put them only in secret storage:

| Variable | Location | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Next.js server / Vercel production | Live voice, reasoning and ephemeral query embeddings |
| `OPENAI_LIVE_ENABLED` | Next.js server | Explicitly set `true` after setup |
| `OPENAI_LIVE_VOICE` | Next.js server | Default `marin` |
| `OPENAI_LIVE_BACKEND_MODEL` | Next.js server | Default `gpt-6-luna` |
| `SUPABASE_URL` | Next.js server | Your own database project URL |
| `INTERNAL_API_TOKEN` | Next.js server | At least 40 characters of cryptographically random secret material, authenticates Edge calls |
| `LIVE_SESSION_SECRET` | Next.js server | Separate random secret, at least 32 characters; never equal to the internal token |
| `SAKINA_INTERNAL_KEY_SHA256` | Supabase Edge secret | Lowercase SHA-256 digest of the internal token |

Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` inside its Edge runtime. Never place the service-role credential in the browser or this repository. No variable needs a `NEXT_PUBLIC_` prefix. Use distinct development/preview/production credentials; leave paid calls disabled on untrusted previews. Rotate a credential immediately if it is exposed.

## Fresh Supabase database

1. Create your own Supabase project and apply the checked-in `supabase/migrations` in order. They contain schema and permissions only.
2. Run `npm run dataset:sql` locally. Verify all source checks pass.
3. Apply `tmp/quran-intelligence/seed/*.sql` in filename order, then `tmp/quran-intelligence/embeddings/seed/*.sql`. Use the SQL Editor or a trusted PostgreSQL connection; never commit its password or connection string.
4. Set the `SAKINA_INTERNAL_KEY_SHA256` Edge secret in the dashboard or authenticated Supabase CLI. Compute the digest locally from your internal token; do not use an online hashing website.
5. Deploy `voice-budget` and `quran-search`, including their relative `_shared/internal-auth.ts` file. Both implement their own credential verification, so their checked-in configuration has JWT verification disabled. Invalid credentials are rejected before any database call.
6. Check 114 chapter rows and 6236 verse/vector rows. Run `supabase/tests/standalone.sql` only in a disposable test database: its admission tests consume a synthetic test reservation.

The semantic and lexical RPCs are executable only by `service_role`; the public application accesses them through the bounded authenticated Edge function. Quran source tables are public read-only data. The quota table is private. No runtime-key rows from any existing installation are needed.

## Existing installation upgrade

Deploy the Edge functions and set the hash secret first. Deploy the Next.js caller with its separate session-signing secret. Verify the new gateway, then apply `supabase/harden-existing.sql` to revoke old anonymous RPC/vector access. Do not reapply the fresh-install migrations or reset quota tables on an existing database.

## Vercel

Import this repository, framework Next.js, Node.js 22, root directory **`apps/sakina`**. Allow source files outside the root so the small workspace HTTP package is included. Use the root workspace lockfile; default Next.js install/build detection is sufficient. Keep project environment values server-only and enable Git fork protection. Production should deploy only trusted `main` commits, with paid preview calls disabled.

Live admission intentionally requires Vercel's trusted client-address header in production. A generic local `next start` does not create paid calls; do not spoof platform headers to bypass this. Use `npm run dev` for local development, or the supported Vercel deployment. Limits remain 6 starts per client/day, 30 global/day, a 60-second cooldown and a 240-second voice session. Original Quran audio can finish after the paid voice session closes.

OpenAI model availability depends on your account. Quran Foundation tafsir is retrieved at runtime using the existing legacy public endpoint; check its [current migration guidance](https://api-docs.quran.com/docs/quickstart/migration/) and [developer terms](https://api-docs.quran.com/legal/developer-terms/) for your deployment. No Quran Foundation content is bundled. If upstream evidence is unavailable, Sakina abstains rather than inventing an interpretation.
