/** Public metadata only. Streams remain on the original reciter CDN.
 * Reproducible import; does not synthesize/edit Quran or download audio files.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  QURAN_SPEECH_CORPUS,
  QURAN_SPEECH_SOURCE,
} from "../apps/sakina/lib/quran-speech-data";

async function json(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Metadata HTTP ${r.status}: ${url}`);
  return r.json();
}
const chaptersResponse = await json(
  "https://www.mp3quran.net/api/v3/suwar?language=ar",
);
const catalog = await json(
  "https://www.mp3quran.net/api/v3/reciters?language=ar&reciter=92",
);
const reciter = catalog.reciters.find((r: { id: number }) => r.id === 92);
const mushaf = reciter?.moshaf.find((m: { id: number }) => m.id === 92);
if (
  !mushaf ||
  mushaf.surah_total !== 114 ||
  mushaf.server !== "https://cdn.mp3quran.net/audio/yasser-dosari/r1/"
)
  throw new Error("Reciter/catalog changed; review source before importing");
const textRows = QURAN_SPEECH_CORPUS.split(/\r?\n/)
  .filter((s) => /^\d+\|\d+\|/.test(s))
  .map((s) => {
    const [surah, ayah, ...text] = s.split("|");
    return { surah: Number(surah), ayah: Number(ayah), text: text.join("|") };
  });
if (
  textRows.length !== 6236 ||
  createHash("sha256").update(QURAN_SPEECH_CORPUS).digest("hex") !==
    QURAN_SPEECH_SOURCE.sha256
)
  throw new Error("Original source hash/count differs");
const chapters: Array<Record<string, unknown>> = [];
const work = chaptersResponse.suwar.map((c: { id: number; name: string }) => ({
  id: c.id,
  name_arabic: c.name,
  verses_count: textRows.filter((v) => v.surah === c.id).length,
}));
const verifyAudio = process.argv.includes("--verify-audio");
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (work.length) {
      const c = work.shift();
      if (!c) break;
      const url = `https://www.mp3quran.net/api/v3/ayat_timing?surah=${c.id}&read=92`;
      const timing = await json(url);
      const verses = textRows.filter((v) => v.surah === c.id);
      if (
        !Array.isArray(timing) ||
        timing.length !== c.verses_count ||
        verses.length !== c.verses_count
      )
        throw new Error(`Count mismatch: ${c.id}`);
      const bounds = timing.map(
        (
          t: { ayah: number; start_time: number; end_time: number },
          i: number,
        ) => {
          if (
            t.ayah !== i + 1 ||
            !Number.isFinite(t.start_time) ||
            !Number.isFinite(t.end_time) ||
            t.start_time < 0 ||
            t.end_time <= t.start_time ||
            (i && t.start_time < timing[i - 1].end_time)
          )
            throw new Error(`Invalid timing: ${c.id}:${i + 1}`);
          return [t.start_time, t.end_time];
        },
      );
      const audioUrl = `${mushaf.server}${String(c.id).padStart(3, "0")}.mp3`;
      if (verifyAudio) {
        const head = await fetch(audioUrl, {
          method: "HEAD",
          headers: { Origin: "https://example.com" },
          signal: AbortSignal.timeout(20000),
        });
        if (
          !head.ok ||
          !head.headers.get("content-type")?.includes("audio") ||
          head.headers.get("access-control-allow-origin") !== "*"
        )
          throw new Error(`Audio unavailable or CORS changed: ${c.id}`);
      }
      chapters.push({
        surah: c.id,
        name: c.name_arabic,
        ayahCount: c.verses_count,
        audioUrl,
        timings: bounds,
      });
    }
  }),
);
chapters.sort((a, b) => Number(a.surah) - Number(b.surah));
if (chapters.length !== 114 || chapters.some((c, i) => c.surah !== i + 1))
  throw new Error("Missing chapter");
const result = {
  retrieved: new Date().toISOString().slice(0, 10),
  reciter: "ياسر الدوسري",
  riwayah: "حفص عن عاصم — مرتل",
  readerId: 92,
  sourceUrl: "https://www.mp3quran.net/api/v3/reciters?language=ar&reciter=92",
  licenseUrl: "https://www.mp3quran.net/ar/privacy",
  chapterNamesSourceUrl: "https://www.mp3quran.net/api/v3/suwar?language=ar",
  verseCountsSourceUrl: QURAN_SPEECH_SOURCE.url,
  chapters,
};
mkdirSync("apps/sakina/lib/data", { recursive: true });
writeFileSync(
  "apps/sakina/lib/data/quran-catalog.json",
  JSON.stringify(result),
);
console.log(
  JSON.stringify({
    chapters: chapters.length,
    verses: textRows.length,
    timings: chapters.reduce((s, c) => s + (c.timings as unknown[]).length, 0),
    audioHeadsVerified: verifyAudio,
  }),
);
