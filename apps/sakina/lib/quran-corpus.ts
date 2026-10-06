import { QURAN_SPEECH_CORPUS, QURAN_SPEECH_SOURCE } from "./quran-speech-data";
import { quranChapter } from "./quran-catalog";

export { QURAN_SPEECH_SOURCE as QURAN_TEXT_SOURCE };
export function normalizeQuranSearch(text: string) {
  return text
    .normalize("NFKC")
    .replace(/[\p{M}\u0640]/gu, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const stop = new Set(
  "في من علي الي عن مع ما لا ان انا هو هي هذا هذه الذي التي كل كان الله رب يا و او ثم".split(
    " ",
  ),
);
export function quranSearchTokens(text: string) {
  const words = normalizeQuranSearch(text).split(" ");
  const terms = new Set<string>();
  for (const word of words) {
    if (word.length < 3 || stop.has(word)) continue;
    terms.add(word);
    const bare = word.replace(/^(?:وال|فال|بال|كال|لل|ال)/, "");
    if (bare.length >= 3 && !stop.has(bare)) terms.add(bare);
  }
  return [...terms];
}
export type QuranVerse = {
  key: string;
  surah: number;
  ayah: number;
  text: string;
  searchText: string;
};
let corpus: QuranVerse[] | undefined;
let keys: Map<string, QuranVerse> | undefined;
export function quranVerses() {
  if (!corpus) {
    corpus = QURAN_SPEECH_CORPUS.split(/\r?\n/)
      .filter((line) => /^\d+\|\d+\|/.test(line))
      .map((line) => {
        const [chapter, number, ...rest] = line.split("|");
        const text = rest.join("|");
        return {
          key: `${chapter}:${number}`,
          surah: Number(chapter),
          ayah: Number(number),
          text,
          searchText: quranSearchTokens(text).join(" "),
        };
      });
    keys = new Map(corpus.map((v) => [v.key, v]));
  }
  return corpus;
}
export function quranVerse(key: string) {
  quranVerses();
  return keys!.get(key);
}
export function parseQuranReference(reference: string) {
  const m = /^(\d{1,3}):(\d{1,3})(?:-(\d{1,3}))?$/.exec(reference);
  if (!m) return undefined;
  const chapter = quranChapter(Number(m[1]));
  const start = Number(m[2]),
    end = Number(m[3] || m[2]);
  if (
    !chapter ||
    start < 1 ||
    end < start ||
    end > chapter.ayahCount ||
    end - start > 5
  )
    return undefined;
  return {
    surah: chapter.surah,
    start,
    end,
    id:
      start === end
        ? `ayah-${chapter.surah}-${start}`
        : `passage-${chapter.surah}-${start}-${end}`,
  };
}

/** Query expansion comes from the dialogue backend. This scorer retrieves evidence;
 * it never labels a verse as a treatment or decides its personal relevance. */
export function rankQuranVerses(
  query: string,
  excluded: number[] = [],
  limit = 8,
) {
  const terms = quranSearchTokens(query).slice(0, 24);
  if (!terms.length) return [];
  const all = quranVerses();
  const counts = terms.map(
    (t) => all.filter((v) => v.searchText.split(" ").includes(t)).length,
  );
  return all
    .filter((v) => !excluded.includes(v.surah))
    .map((v) => {
      const words = new Set(v.searchText.split(" "));
      const score =
        terms.reduce(
          (sum, t, i) =>
            sum +
            (words.has(t) ? Math.log(1 + all.length / (1 + counts[i])) : 0),
          0,
        ) / Math.sqrt(Math.max(8, words.size));
      return { key: v.key, score };
    })
    .filter((v) => v.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(12, limit));
}
