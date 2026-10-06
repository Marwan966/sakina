# Architecture and operations

The browser owns microphone permission, voice playback, interruption detection and the original-recording player. The Next.js server owns OpenAI credentials, live session creation, signed session grants, source retrieval and tool authorization. The backend model searches the complete Quran using semantic and lexical evidence, reads exact verses and runtime tafsir, and proposes only a candidate tied to the current user context. Playback requires fresh consent. Original recordings use publisher intervals and never overlap generated speech.

The authenticated Supabase Edge gateway accepts only bounded lexical terms or one normalized 1024-dimensional vector; it calls fixed read-only RPCs. It validates the internal credential locally before any database I/O. The separate admission function calls the serial, bounded reservation procedure. Neither gateway stores caller words, audio or query vectors.

The offline dataset is not downloaded by the browser. Only source text needed for the scripture speech guard and the recording metadata are used by the app; embedding shards remain a deployment/setup artifact. Fresh database setup reuses them without an embedding bill. No dependency on another application or repository exists.

## Incident handling

- Keep full credentials and conversation content out of logs, issue reports and screenshots.
- Stop new paid sessions using `OPENAI_LIVE_ENABLED=false` if an incident requires containment.
- Rotate exposed provider credentials in the provider account and deployment secret store; removing a key from Git history does not revoke it.
- Roll back the application to a verified deployment if needed. Preserve additive Quran tables and live quota records. A rollback to a caller that uses anonymous database RPCs requires review of the hardened database permissions.
- Review dependency alerts and CI failures before updating production. Do not expose production secrets to pull requests or forks.

Automated tests exercise malformed requests, stale grants, source/consent checks, duplicate playback, interruptions, handoffs and failure cleanup. They do not guarantee clinical efficacy, scholarly approval, flawless Arabic pronunciation or every physical device's microphone behavior.
