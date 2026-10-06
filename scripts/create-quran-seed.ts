import { mkdirSync, writeFileSync } from "node:fs";
import {
  quranVerses,
  QURAN_TEXT_SOURCE,
} from "../apps/sakina/lib/quran-corpus";
import { QURAN_CATALOG } from "../apps/sakina/lib/quran-catalog";
import { QURAN_SPEECH_CORPUS } from "../apps/sakina/lib/quran-speech-data";
const quoted = (text: string) => `'${text.replace(/'/g, "''")}'`;
const dir = "tmp/quran-intelligence/seed";
mkdirSync(dir, { recursive: true });
const notice = QURAN_SPEECH_CORPUS.slice(
  QURAN_SPEECH_CORPUS.indexOf(
    "#====================================================================",
  ),
);
const sourceId = "tanzil-simple-clean-1.1";
const source = `insert into public.quran_sources(id,provider,version,source_url,license_url,sha256,original_notice) values (${[sourceId, QURAN_TEXT_SOURCE.provider, QURAN_TEXT_SOURCE.version, QURAN_TEXT_SOURCE.url, QURAN_TEXT_SOURCE.licenseUrl, QURAN_TEXT_SOURCE.sha256, notice].map(quoted).join(",")}) on conflict(id) do nothing;`;
const chapters = QURAN_CATALOG.chapters
  .map(
    (c) =>
      `(${c.surah},${quoted(c.name)},${c.ayahCount},${quoted(QURAN_CATALOG.reciter)},${quoted(c.audioUrl)},${quoted(`https://www.mp3quran.net/api/v3/ayat_timing?surah=${c.surah}&read=92`)})`,
  )
  .join(",\n");
writeFileSync(
  `${dir}/000.sql`,
  `${source}\ninsert into public.quran_chapters(surah,name_arabic,ayah_count,reciter,audio_url,timing_source_url) values ${chapters} on conflict(surah) do nothing;`,
);
const verses = quranVerses();
const batchSize = 100;
for (let index = 0; index < verses.length; index += batchSize) {
  const values = verses
    .slice(index, index + batchSize)
    .map((v) => {
      const timing = QURAN_CATALOG.chapters[v.surah - 1].timings[v.ayah - 1];
      return `(${quoted(v.key)},${v.surah},${v.ayah},${quoted(v.text)},${quoted(v.searchText)},${quoted(sourceId)},${timing[0]},${timing[1]})`;
    })
    .join(",\n");
  writeFileSync(
    `${dir}/${String(index / batchSize + 1).padStart(3, "0")}.sql`,
    `insert into public.quran_verses(verse_key,surah,ayah,text_exact,search_text,source_id,start_ms,end_ms) values ${values} on conflict(verse_key) do nothing;`,
  );
}
console.log(
  JSON.stringify({
    batches: 1 + Math.ceil(verses.length / batchSize),
    verses: verses.length,
    chapters: QURAN_CATALOG.chapters.length,
    sourceSha256: QURAN_TEXT_SOURCE.sha256,
  }),
);
