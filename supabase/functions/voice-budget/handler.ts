import {
  internalAuthorized,
  boundedJson,
  reply,
  type EdgeEnvironment,
} from "../_shared/internal-auth.ts";
export function createVoiceBudgetHandler(
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
      const data = (await boundedJson(request, 200)) as Record<string, unknown>;
      if (
        !data ||
        Object.keys(data).length !== 1 ||
        typeof data.clientHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(data.clientHash)
      )
        return reply({ error: "invalid" }, 400);
      const base = env.get("SUPABASE_URL"),
        key = env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!base || !key) return reply({ error: "unavailable" }, 503);
      const result = await fetcher(
        `${base}/rest/v1/rpc/reserve_voice_session`,
        {
          method: "POST",
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ p_client_hash: data.clientHash }),
          signal: AbortSignal.timeout(4000),
          cache: "no-store",
        },
      );
      if (!result.ok) return reply({ error: "unavailable" }, 503);
      return (await result.json()) === true
        ? reply({ allowed: true })
        : reply({ allowed: false }, 429);
    } catch {
      return reply({ error: "unavailable" }, 503);
    }
  };
}
