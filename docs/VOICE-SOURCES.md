# Recitation audio sources

Sakina plays only original human recordings. The assistant's generated voice is never used for Quran recitation.

## Source

| Item | Value |
| --- | --- |
| Publisher | MP3Quran (mp3quran.net) |
| Reciter | Yasser Al-Dosari (ياسر الدوسري), MP3Quran reader ID `92` |
| Riwayah | Hafs from Asim, murattal |
| Audio files | `https://cdn.mp3quran.net/audio/yasser-dosari/r1/NNN.mp3` (one file per chapter, 114 files) |
| Reciter metadata | https://www.mp3quran.net/api/v3/reciters?language=ar&reciter=92 |
| Chapter names | https://www.mp3quran.net/api/v3/suwar?language=ar |
| Verse timings | `https://www.mp3quran.net/api/v3/ayat_timing?surah=N&read=92` |
| Local copy of metadata | `apps/sakina/lib/data/quran-catalog.json` (catalog `retrieved`: 2026-10-06), `dataset/recitations.json` |

## How the audio is used

- The browser streams each file directly from `cdn.mp3quran.net`. The repository and the server hold no audio copies, and the audio is not re-hosted, transcoded, re-encoded or altered.
- Passages are played by seeking inside the original chapter file. Playback is bounded by the publisher's own verse timings (`BoundedRecording`). No new files are cut or produced.
- The interface shows the reciter's name, the reference and a "مصدر التسجيل" link for every recording.
- Verse counts in the timing data are checked against the Tanzil text (`scripts/sync-quran-catalog.ts`).

## License status

**No formal license for the recordings has been obtained, and none has been found.**

- MP3Quran does not publish a named license for these recordings, such as a Creative Commons or other standard license.
- The repository uses https://www.mp3quran.net/ar/privacy as its `licenseUrl`. That page is a privacy policy, not a license.
- When the page was checked on 2026-10-06, it contained a general statement allowing visitors and developers to copy site material and use its links. This is a paraphrase, not a quotation.
- The page does not mention audio recordings, streaming in third-party applications, API use, attribution, commercial use, or redistribution.
- No written permission from MP3Quran or from the reciter is on file. No agreement exists with either of them.
- The page states the publisher's permission. It is not a statement from the reciter. Any rights the reciter may hold in his recitations have not been examined.
- The page wording can change. No dated copy of it is archived in this repository.

### What this means in practice

- Linking to and streaming the publisher's public files appears to be covered by the publisher's general statement. This rests on that statement alone. Nobody has obtained legal review or confirmation from the publisher.
- The terms page states that listening through Sakina grants no general license to redistribute the recordings.
- Sakina depends on the availability of MP3Quran's CDN. If a file is unavailable, playback fails and is reported to the user. The assistant does not recite as a substitute.
- When the browser streams a file, MP3Quran receives the user's connection data, such as their IP address. The privacy page states this.

## Open items

- Ask MP3Quran in writing to confirm that streaming in Sakina is permitted, including any attribution wording they require.
- Keep a dated copy of whatever terms apply at the time of any public or commercial launch.
- Re-check this document whenever the reciter, the publisher or the delivery method changes.
