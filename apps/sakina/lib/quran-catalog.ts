import catalog from "./data/quran-catalog.json";

/** Validated public metadata; never inferred timings or model-provided URLs. */
export const QURAN_CATALOG = catalog;
export const QURAN_CHAPTERS = catalog.chapters;
export function quranChapter(number: number) {
  return Number.isInteger(number)
    ? QURAN_CHAPTERS.find((c) => c.surah === number)
    : undefined;
}
export function quranRange(id: string) {
  const full = /^surah-([1-9]\d{0,2})$/.exec(id);
  const part =
    /^ayah-([1-9]\d{0,2})-([1-9]\d{0,2})$/.exec(id) ||
    /^passage-([1-9]\d{0,2})-([1-9]\d{0,2})-([1-9]\d{0,2})$/.exec(id);
  if (!full && !part) return undefined;
  const c = quranChapter(Number((full || part)![1]));
  if (!c) return undefined;
  const start = full ? 1 : Number(part![2]);
  const end = full ? c.ayahCount : Number(part![3] || part![2]);
  if (id.startsWith("passage-") && start === end) return undefined;
  if (
    start < 1 ||
    end < start ||
    end > c.ayahCount ||
    (!full && end - start > 9)
  )
    return undefined;
  return { chapter: c, start, end, full: !!full };
}
