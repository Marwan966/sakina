import { getRecitation, type Recitation } from "./recitations";
import {
  parseQuranReference,
  quranVerse,
  quranSearchTokens,
  rankQuranVerses,
} from "./quran-corpus";
import { semanticQuranKeys } from "./quran-semantic";
import { sourcePlainText } from "./source-text";

export type QuranSearchCandidate = {
  id: string;
  recitation: Recitation;
  verses: Array<{
    key: string;
    text: string;
    tafsir: string;
    tafsirSourceUrl: string;
  }>;
  surroundingVerses: Array<{ key: string; text: string }>;
  source: string;
};
export type QuranSearchInput = {
  query: string;
  concepts?: string[];
  references?: string[];
  excludeSurahs?: number[];
  limit?: number;
};
export type QuranSearchResult = {
  candidates: QuranSearchCandidate[];
  status: "ok" | "unavailable";
};
const cache = new Map<string, { text: string; url: string; expires: number }>();
async function tafsir(key: string, fetcher: typeof fetch) {
  const existing = cache.get(key);
  if (fetcher === fetch && existing && existing.expires > Date.now())
    return existing;
  const url = `https://api.quran.com/api/v4/tafsirs/16/by_ayah/${key}`;
  try {
    const r = await fetcher(url, {
      signal: AbortSignal.timeout(6000),
      cache: "no-store",
    });
    if (!r.ok) return undefined;
    const value = await r.json();
    const t = value.tafsir;
    if (
      t?.resource_id !== 16 ||
      !Object.hasOwn(t.verses || {}, key) ||
      typeof t.text !== "string" ||
      t.text.length > 30000
    )
      return undefined;
    const text = sourcePlainText(t.text);
    if (text.length < 20) return undefined;
    const result = { text, url, expires: Date.now() + 3600_000 };
    // Runtime lookup only; no bulk-imported tafsir or persistent offline copy.
    if (fetcher === fetch) {
      if (cache.size >= 256) cache.delete(cache.keys().next().value!);
      cache.set(key, result);
    }
    return result;
  } catch {
    return undefined;
  }
}

async function databaseKeys(
  query: string,
  excluded: number[],
  limit: number,
  fetcher: typeof fetch,
) {
  const base = process.env.SUPABASE_URL,
    key = process.env.INTERNAL_API_TOKEN;
  if (!base || !key) return [];
  try {
    const r = await fetcher(`${base}/functions/v1/quran-search`, {
      method: "POST",
      headers: { "X-Internal-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "lexical",
        terms: quranSearchTokens(query).slice(0, 24),
        excluded_surahs: excluded,
        take_count: limit,
      }),
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data)
      ? data
          .map((v) => v.verse_key)
          .filter((s): s is string => typeof s === "string" && !!quranVerse(s))
          .slice(0, limit)
      : [];
  } catch {
    return [];
  }
}

export async function searchQuran(
  input: QuranSearchInput,
  options: { fetcher?: typeof fetch; skipDatabase?: boolean } = {},
): Promise<QuranSearchResult> {
  const fetcher = options.fetcher || fetch;
  if (typeof input.query !== "string" || input.query.length > 500)
    return { status: "unavailable", candidates: [] };
  if (
    input.concepts !== undefined &&
    (!Array.isArray(input.concepts) ||
      input.concepts.length < 2 ||
      input.concepts.length > 6 ||
      input.concepts.some(
        (concept) =>
          typeof concept !== "string" ||
          concept.trim().length < 2 ||
          concept.trim().length > 40,
      ))
  )
    return { status: "unavailable", candidates: [] };
  // The dialogue backend translates a personal concern into source-relevant
  // concepts. Keep raw concern context out of ranking when that plan exists.
  // Concepts are search hints, never quoted scripture or verified evidence.
  const rankingQuery =
    input.concepts?.map((concept) => concept.trim()).join(" ") ?? input.query;
  const limit = Math.max(1, Math.min(6, Math.trunc(input.limit || 6)));
  const excluded = (input.excludeSurahs || [])
    .filter(Number.isInteger)
    .slice(0, 114);
  const requested = (input.references || [])
    .slice(0, 6)
    .filter((s) => typeof s === "string" && !!parseQuranReference(s));
  // Oversample before duration checks so one long ayah doesn't hide short usable evidence.
  const [semantic, db] = options.skipDatabase
    ? [[], []]
    : await Promise.all([
        semanticQuranKeys(rankingQuery, excluded, 12, { fetcher }),
        databaseKeys(rankingQuery, excluded, 12, fetcher),
      ]);
  const ranked = db.length
    ? db
    : rankQuranVerses(rankingQuery, excluded, 12).map((v) => v.key);
  const seen = new Set<string>();
  // Named references retain precedence. Meaning-based retrieval supplies the
  // next evidence; lexical search remains available if vectors/provider fail.
  const ranges = [...requested, ...semantic, ...ranked]
    .flatMap((ref) => {
      const range = parseQuranReference(ref);
      if (!range || excluded.includes(range.surah) || seen.has(range.id))
        return [];
      const recitation = getRecitation(range.id);
      if (
        !recitation ||
        !recitation.durationSeconds ||
        recitation.durationSeconds > 100
      )
        return [];
      seen.add(range.id);
      return [{ range, recitation }];
    })
    .slice(0, limit);
  const candidates = await Promise.all(
    ranges.map(async ({ range, recitation }) => {
      const values = await Promise.all(
        Array.from({ length: range.end - range.start + 1 }, async (_, i) => {
          const key = `${range.surah}:${range.start + i}`,
            verse = quranVerse(key),
            evidence = await tafsir(key, fetcher);
          return verse && evidence
            ? {
                key,
                text: verse.text,
                tafsir: evidence.text,
                tafsirSourceUrl: evidence.url,
              }
            : null;
        }),
      );
      if (values.some((v) => !v)) return null;
      const surroundingVerses = [
        `${range.surah}:${range.start - 1}`,
        `${range.surah}:${range.end + 1}`,
      ].flatMap((k) => {
        const v = quranVerse(k);
        return v ? [{ key: v.key, text: v.text }] : [];
      });
      return {
        id: range.id,
        recitation,
        verses: values as QuranSearchCandidate["verses"],
        surroundingVerses,
        source:
          "نص القرآن: Tanzil Simple Clean 1.1؛ التفسير الميسر: Quran Foundation / المورد 16؛ التسجيل والتوقيت: MP3Quran / ياسر الدوسري 92",
      };
    }),
  );
  const valid = candidates.filter((c): c is QuranSearchCandidate => !!c);
  return { status: valid.length ? "ok" : "unavailable", candidates: valid };
}
