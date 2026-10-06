# Architecture and operations

The browser owns microphone permission, voice playback, interruption detection and the original-recording player. The Next.js server owns OpenAI credentials, live session creation, signed session grants, source retrieval and tool authorization. The backend model searches the complete Quran using semantic and lexical evidence, reads exact verses and runtime tafsir, and proposes only a candidate tied to the current user context. Playback requires fresh consent. Original recordings use publisher intervals and never overlap generated speech.

Each live stream keeps a bounded, in-memory recommendation record: exact source, passage, user concern, connection and selection status. `get_session_recitation` recalls that record without searching, replacing it or playing audio. A pending proposal lasts until the session deadline or explicit dismissal; malformed confirmation arguments cannot erase it. Source identity remains available after a playback request, which is deliberately not reported as proof that the browser played or the caller heard it. This state is cleared when the stream ends and is never stored in the database.

A one-shot progress controller can recover a missed initial delegation after a substantive caller description and an actual assistant response. It waits for recent caller speech to stop and yields to native backend work, then explicitly requests the configured Responses backend using an application-authored task and a separate, bounded untrusted caller snapshot. The input revision is frozen before dispatch so intervening speech requires revalidation. The backend still uses the same source, safety, refusal and fresh-consent checks; the controller cannot select a passage or authorize playback. Semantic retrieval has one six-second deadline across embedding and database lookup, without retries, and supplies up to six source-checked candidates. Only errors correlated to this optional kickoff are handled without resetting live audio. Model behavior still needs live evaluation: automated state tests alone do not prove spoken relevance or delivery.

Native work pauses this controller without erasing caller context. A reply containing only empathy can resume the missed-lookup check once all backend work is idle; failed source retrieval prevents another automatic lookup. If validated candidates were returned without a preparation decision, the one-shot recovery can finish that decision using the same cached snapshot; a source-validated unsupported or uncertain decision is respected. Recovery captures only that current, completed native owner and also accepts unscoped responses. New native work supersedes it. Validated input revisions carry forward across search and preparation so a corrected caller snapshot cannot revert to the original partial transcript.

The authenticated Supabase Edge gateway accepts only bounded lexical terms or one normalized 1024-dimensional vector; it calls fixed read-only RPCs. It validates the internal credential locally before any database I/O. The separate admission function calls the serial, bounded reservation procedure. Neither gateway stores caller words, audio or query vectors.

The offline dataset is not downloaded by the browser. Only source text needed for the scripture speech guard and the recording metadata are used by the app; embedding shards remain a deployment/setup artifact. Fresh database setup reuses them without an embedding bill. No dependency on another application or repository exists.

## Incident handling

- Keep full credentials and conversation content out of logs, issue reports and screenshots.
- Stop new paid sessions using `OPENAI_LIVE_ENABLED=false` if an incident requires containment.
- Rotate exposed provider credentials in the provider account and deployment secret store; removing a key from Git history does not revoke it.
- Roll back the application to a verified deployment if needed. Preserve additive Quran tables and live quota records. A rollback to a caller that uses anonymous database RPCs requires review of the hardened database permissions.
- Review dependency alerts and CI failures before updating production. Do not expose production secrets to pull requests or forks.

Automated tests exercise malformed requests, stale grants, source/consent checks, duplicate playback, interruptions, handoffs and failure cleanup. They do not guarantee clinical efficacy, scholarly approval, flawless Arabic pronunciation or every physical device's microphone behavior.
