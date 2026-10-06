import {
  internalAuthorized,
  boundedJson,
  reply,
  type EdgeEnvironment,
} from "../_shared/internal-auth.ts";
export function createQuranSearchHandler(
  env: EdgeEnvironment,
  fetcher: typeof fetch = fetch,
) {
  return async (request: Request) => {
    if (request.method !== "POST") return reply({ error: "method" }, 405);
    if (
      !(await internalAuthorized(
        request,
        env.get("SAKINA_INTERNAL_KEY_SHA256"),
      ))
    )
      return reply({ error: "unauthorized" }, 401);
    try {
      const data = (await boundedJson(request, 40000)) as Record<
        string,
        unknown
      >;
      if (!data || typeof data !== "object" || Array.isArray(data))
        return reply({ error: "invalid" }, 400);
      const semantic = data.kind === "semantic";
      const expected = [
        "kind",
        semantic ? "query_embedding" : "terms",
        "excluded_surahs",
        "take_count",
      ]
        .sort()
        .join();
      if (
        !["semantic", "lexical"].includes(String(data.kind)) ||
        Object.keys(data).sort().join() !== expected ||
        !Number.isInteger(data.take_count) ||
        Number(data.take_count) < 1 ||
        Number(data.take_count) > 12 ||
        !Array.isArray(data.excluded_surahs) ||
        data.excluded_surahs.length > 114 ||
        data.excluded_surahs.some(
          (n) => !Number.isInteger(n) || n < 1 || n > 114,
        )
      )
        return reply({ error: "invalid" }, 400);
      if (semantic) {
        const vector = data.query_embedding;
        if (
          !Array.isArray(vector) ||
          vector.length !== 1024 ||
          vector.some(
            (n) =>
              typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1,
          )
        )
          return reply({ error: "invalid" }, 400);
        const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0));
        if (norm < 0.9 || norm > 1.1) return reply({ error: "invalid" }, 400);
      } else if (
        !Array.isArray(data.terms) ||
        data.terms.length < 1 ||
        data.terms.length > 24 ||
        data.terms.some(
          (t) => typeof t !== "string" || t.length < 1 || t.length > 80,
        )
      )
        return reply({ error: "invalid" }, 400);
      const base = env.get("SUPABASE_URL"),
        key = env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!base || !key) return reply({ error: "unavailable" }, 503);
      const { kind, ...parameters } = data;
      const result = await fetcher(
        `${base}/rest/v1/rpc/${semantic ? "match_quran_corpus" : "search_quran_corpus"}`,
        {
          method: "POST",
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(parameters),
          signal: AbortSignal.timeout(3000),
          cache: "no-store",
        },
      );
      if (!result.ok) return reply({ error: "unavailable" }, 503);
      const rows = await result.json();
      if (!Array.isArray(rows)) return reply({ error: "unavailable" }, 503);
      return reply(
        rows
          .slice(0, Number(data.take_count))
          .filter(
            (row) =>
              typeof row.verse_key === "string" &&
              /^\d{1,3}:\d{1,3}$/.test(row.verse_key),
          )
          .map((row) =>
            semantic
              ? { verse_key: row.verse_key, similarity: row.similarity }
              : { verse_key: row.verse_key },
          ),
      );
    } catch {
      return reply({ error: "invalid_or_unavailable" }, 400);
    }
  };
}
