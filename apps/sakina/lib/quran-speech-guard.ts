import { QURAN_SPEECH_CORPUS } from "./quran-speech-data";

/** Match ordinary Arabic transcripts to Imlaei source without vocalization. */
export function normalizeQuranSpeech(text: string): string {
  return (
    text
      .normalize("NFKC")
      .replace(/[\p{M}\u0640]/gu, "")
      .replace(/[أإآٱ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/[^\p{Script=Arabic}\p{L}\p{N}]+/gu, " ")
      .trim()
      .replace(/\s+/g, " ")
      // Search-key equivalences for ordinary Imlaei transcript spellings. The
      // source download remains verbatim; these keys are never rendered/spoken.
      .replace(/(^| )بعدما(?= |$)/g, "$1بعد ما")
      .replace(/(^| )ويلتا(?= |$)/g, "$1ويلتي")
      .replace(/(^| )حسرتا(?= |$)/g, "$1حسرتي")
      .replace(/(^| )الزنا(?= |$)/g, "$1الزني")
  );
}

const longSequences = new Set<string>();
const shortVerses = new Set<string>();
const distinctiveTwoWordVerses = new Set(["الله الصمد"]);
const unfinishedPrefixes = new Set<string>();

const sourceVerses = QURAN_SPEECH_CORPUS.split(/\r?\n/)
  .filter((line) => /^\d+\|\d+\|/.test(line))
  .map((line) => {
    const [surah, ayah, text] = line.split("|");
    return { surah: Number(surah), ayah: Number(ayah), text };
  });
if (sourceVerses.length !== 6236) throw new Error("invalid_quran_guard_source");
const opening = normalizeQuranSpeech(sourceVerses[0].text);

function indexVerse(verse: string) {
  const words = verse.split(" ");
  // Common single words and two-word phrases are not proof of Quran recitation.
  if (words.length >= 3 && words.length <= 4) shortVerses.add(verse);
  for (let size = 2; size <= 4 && size < words.length; size += 1) {
    unfinishedPrefixes.add(words.slice(0, size).join(" "));
  }
  for (let i = 0; i + 5 <= words.length; i += 1) {
    longSequences.add(words.slice(i, i + 5).join(" "));
    // Three words are required for an in-verse fragment: ordinary two-word
    // combinations elsewhere in long verses are too broad a reason to hold.
    for (const size of [3, 4]) {
      unfinishedPrefixes.add(words.slice(i, i + size).join(" "));
    }
  }
}

for (const source of sourceVerses) {
  const normalized = normalizeQuranSpeech(source.text);
  indexVerse(normalized);
  // Tanzil includes the opening formula in the first record of chapters other
  // than 1 and 9. Also index the actual first verse independently so quotations
  // and incomplete prefixes remain detectable without that formula.
  if (
    source.ayah === 1 &&
    source.surah !== 1 &&
    source.surah !== 9 &&
    normalized.startsWith(`${opening} `)
  ) {
    indexVerse(normalized.slice(opening.length + 1));
  }
}

/**
 * A conservative source-overlap gate, not a guarantee of religious correctness.
 * Run on the accumulated assistant transcript BEFORE its buffered audio plays.
 * It catches five consecutive source words and complete 3–4-word verses, plus
 * explicitly distinctive shorter verses. It cannot prove absence of a tiny
 * quotation, an ASR error, or paraphrase. Never apply it to the human's speech.
 * Lazy-import this module when starting a call, not in the landing-page bundle.
 */
export function isQuranRecitation(text: string): boolean {
  if (typeof text !== "string" || !text.trim()) return false;
  const words = normalizeQuranSpeech(text).split(" ");
  for (let i = 0; i < words.length; i += 1) {
    if (
      i + 5 <= words.length &&
      longSequences.has(words.slice(i, i + 5).join(" "))
    ) {
      return true;
    }
    for (const size of [3, 4]) {
      if (
        i + size <= words.length &&
        shortVerses.has(words.slice(i, i + size).join(" "))
      ) {
        return true;
      }
    }
    if (
      i + 2 <= words.length &&
      distinctiveTwoWordVerses.has(words.slice(i, i + 2).join(" "))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Hold a candidate audio segment when its last words could be an unfinished
 * quotation. Recheck with subsequent transcript text: a non-Quran continuation
 * can clear the hold. This is uncertainty, not a confirmed Quran quotation.
 * If continuation never arrives, the player must discard after its bounded
 * timeout rather than release an unresolved prefix. One-word fragments and
 * transcription errors remain outside this heuristic's guarantees.
 */
export function hasQuranPrefix(text: string): boolean {
  if (typeof text !== "string" || !text.trim()) return false;
  const words = normalizeQuranSpeech(text).split(" ");
  for (let size = 2; size <= 4 && size <= words.length; size += 1) {
    if (unfinishedPrefixes.has(words.slice(-size).join(" "))) return true;
  }
  return false;
}
