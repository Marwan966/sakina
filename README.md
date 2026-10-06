# سَكينة · Sakina

Arabic live voice support with source-grounded Quran listening. The public page needs no account: speak, hear a brief contextual response, then choose whether to listen to an original Yasser Al-Dosari recording. The assistant never substitutes its own voice for Quran recitation.

Sakina offers emotional and spiritual support, not psychotherapy, diagnosis, fatwas or emergency care. Model relevance and voice quality are fallible.

## What is included

- The independent Next.js frontend and server, live audio lifecycle, interruption recovery, consent and duplicate-playback controls.
- All **114 chapters / 6,236 exact licensed Quran verses**, original recording URLs and publisher verse timings.
- **6,236 existing 1,024-dimensional embeddings**, compressed into 98 checked shards (~28 MB). Restoring them makes no paid embedding request.
- Supabase schema, protected Edge functions, database admission limits, tests and CI.

The repository contains no deployed credentials, caller conversations, audio captures, database key rows, or history from the earlier combined project. Recitation audio remains on MP3Quran; tafsir is retrieved on demand and is not distributed as a dataset.

## Local setup

Use Node.js **22** and npm. From the repository root:

```sh
npm ci
cp apps/sakina/.env.example apps/sakina/.env.local
npm run dataset:verify
npm run dev
```

Open http://localhost:3000. The page and offline tests work without API keys. Live calls require your own configured services; `OPENAI_LIVE_ENABLED` defaults to `false`. Do not paste credentials into issues, source code, screenshots or chat.

See [deployment and database setup](docs/SETUP.md), [dataset provenance and licensing](dataset/README.md), [architecture and operations](docs/ARCHITECTURE.md), and [security policy](SECURITY.md).

## Verification

```sh
npm run dataset:verify
npm test
npm run typecheck
npm run build
npm run test:e2e
npm run security:check
npm audit --omit=dev
```

`security:check` scans Git-tracked files, including decompressed dataset shards. CI also scans Git history with Gitleaks and tests schema/data restoration on an empty PostgreSQL database. Browser regressions use controlled transports; they do not rate the model's voice or prove physical iPhone behavior. Actual-provider testing requires configured credentials and incurs API usage.

## Data and code rights

The [Tanzil notice](dataset/LICENSE-TANZIL.txt) applies to the verbatim Quran text and its derived dataset. [Third-party notices](THIRD_PARTY_NOTICES.md) explain the other sources. Public visibility alone does not grant a general reuse license for the application code; no MIT/Apache license has been applied on the owner's behalf.
