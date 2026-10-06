import { quranVerse, QURAN_TEXT_SOURCE } from "./quran-corpus";

export const QURAN_EMBEDDING_MODEL = "text-embedding-3-large";
export const QURAN_EMBEDDING_DIMENSIONS = 1024;
export const QURAN_EMBEDDING_INPUT_VERSION = "tanzil-target-neighbors-v1";
export const QURAN_EMBEDDING_SOURCE_SHA256 = QURAN_TEXT_SOURCE.sha256;

/** Only verbatim licensed verses from the same chapter. No generated religious
 * interpretation, personal-condition labels, or bulk tafsir is indexed. */
export function quranEmbeddingInput(key: string) {
  const verse = quranVerse(key);
  if (!verse) throw new Error("unknown_quran_verse");
  const previous = quranVerse(`${verse.surah}:${verse.ayah - 1}`);
  const next = quranVerse(`${verse.surah}:${verse.ayah + 1}`);
  return [
    `الآية المقصودة (${verse.key}):\n${verse.text}`,
    previous ? `الآية السابقة (${previous.key}):\n${previous.text}` : "",
    next ? `الآية التالية (${next.key}):\n${next.text}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function validQuranEmbedding(value: unknown): value is number[] {
  if (
    !Array.isArray(value) ||
    value.length !== QURAN_EMBEDDING_DIMENSIONS ||
    !value.every((n) => typeof n === "number" && Number.isFinite(n))
  )
    return false;
  // OpenAI returns normalized embeddings, including shortened dimensions.
  const norm = Math.sqrt(value.reduce((sum, n) => sum + n * n, 0));
  return norm >= 0.9 && norm <= 1.1;
}

export function readQuranEmbeddings(value: unknown, count: number): number[][] {
  const response = value as { model?: unknown; data?: unknown };
  if (
    !response ||
    response.model !== QURAN_EMBEDDING_MODEL ||
    !Array.isArray(response.data) ||
    response.data.length !== count
  )
    throw new Error("invalid_embedding_response");
  const ordered = new Array<number[]>(count);
  for (const item of response.data) {
    if (
      !item ||
      !Number.isInteger(item.index) ||
      item.index < 0 ||
      item.index >= count ||
      ordered[item.index] ||
      !validQuranEmbedding(item.embedding)
    )
      throw new Error("invalid_embedding_vector");
    ordered[item.index] = item.embedding;
  }
  return ordered;
}

type SemanticOptions = {
  fetcher?: typeof fetch;
  apiKey?: string;
  databaseUrl?: string;
  internalKey?: string;
};

/** Server-side ephemeral query embedding. Nothing here writes, caches, or logs
 * caller words/vectors. Failure returns to lexical retrieval and source checks. */
export async function semanticQuranKeys(
  query: string,
  excludedSurahs: number[] = [],
  limit = 12,
  options: SemanticOptions = {},
): Promise<string[]> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const databaseUrl = options.databaseUrl ?? process.env.SUPABASE_URL;
  const internalKey = options.internalKey ?? process.env.INTERNAL_API_TOKEN;
  if (
    !apiKey ||
    !databaseUrl ||
    !internalKey ||
    typeof query !== "string" ||
    !query.trim() ||
    query.length > 500
  )
    return [];
  const fetcher = options.fetcher ?? fetch;
  const excluded = [
    ...new Set(
      excludedSurahs.filter((n) => Number.isInteger(n) && n >= 1 && n <= 114),
    ),
  ].slice(0, 114);
  const take = Number.isFinite(limit)
    ? Math.max(1, Math.min(12, Math.trunc(limit)))
    : 12;
  // One six-second budget covers embedding plus database lookup. Lexical
  // retrieval runs alongside it; no retry delays the live conversation.
  const signal = AbortSignal.timeout(6000);
  try {
    const response = await fetcher("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: QURAN_EMBEDDING_MODEL,
        dimensions: QURAN_EMBEDDING_DIMENSIONS,
        encoding_format: "float",
        input: query,
      }),
      signal,
      cache: "no-store",
    });
    if (!response.ok) return [];
    const [embedding] = readQuranEmbeddings(await response.json(), 1);
    const result = await fetcher(
      `${databaseUrl.replace(/\/$/, "")}/functions/v1/quran-search`,
      {
        method: "POST",
        headers: {
          "X-Internal-Key": internalKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "semantic",
          query_embedding: embedding,
          excluded_surahs: excluded,
          take_count: take,
        }),
        signal,
        cache: "no-store",
      },
    );
    if (!result.ok) return [];
    const data: unknown = await result.json();
    if (!Array.isArray(data)) return [];
    const seen = new Set<string>();
    return data
      .flatMap((row) => {
        const verse =
          row && typeof row.verse_key === "string"
            ? quranVerse(row.verse_key)
            : undefined;
        if (
          !verse ||
          excluded.includes(verse.surah) ||
          seen.has(verse.key) ||
          typeof row.similarity !== "number" ||
          !Number.isFinite(row.similarity) ||
          row.similarity < -1 ||
          row.similarity > 1.000001
        )
          return [];
        seen.add(verse.key);
        return [verse.key];
      })
      .slice(0, take);
  } catch {
    return [];
  }
}
