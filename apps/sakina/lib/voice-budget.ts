import { createHmac } from "node:crypto";
import { HttpError } from "@platform/core/http";

const localStarts = new Map<string, { count: number; expires: number }>();

/** Admit paid sessions before contacting OpenAI. No conversation content is sent. */
export async function reserveVoiceBudget(request: Request): Promise<void> {
  const production = process.env.NODE_ENV === "production";
  const secret = process.env.INTERNAL_API_TOKEN;
  const base = process.env.SUPABASE_URL;
  if (!production) {
    const now = Date.now();
    for (const [key, value] of localStarts)
      if (value.expires < now) localStarts.delete(key);
    const key = "local-voice";
    const bucket = localStarts.get(key) ?? { count: 0, expires: now + 60_000 };
    bucket.count++;
    localStarts.set(key, bucket);
    if (bucket.count > 10)
      throw new HttpError(
        429,
        "محاولات كثيرة خلال دقيقة. انتظر قليلًا ثم حاول مجددًا.",
      );
    return;
  }
  if (!secret || !base || !process.env.VERCEL) {
    throw new HttpError(503, "المكالمة غير متاحة مؤقتًا. حاول بعد قليل.");
  }
  // This header is supplied by Vercel, unlike caller-controlled X-Forwarded-For.
  const ip = request.headers
    .get("x-vercel-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  if (!ip) throw new HttpError(503, "تعذّر بدء المكالمة. حاول بعد قليل.");
  const clientHash = createHmac("sha256", secret)
    .update(`sakina-voice:${new Date().toISOString().slice(0, 10)}:${ip}`)
    .digest("hex");
  try {
    const response = await fetch(`${base}/functions/v1/voice-budget`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": secret },
      body: JSON.stringify({ clientHash }),
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });
    if (response.status === 429) {
      throw new HttpError(
        429,
        "وصلنا إلى الحد المتاح للمكالمات حاليًا. جرّب في وقت لاحق.",
      );
    }
    if (!response.ok || (await response.json()).allowed !== true)
      throw new Error("unavailable");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "المكالمة غير متاحة مؤقتًا. حاول بعد قليل.");
  }
}
