import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { HttpError } from "@platform/core/http";
import type { ZodType } from "zod";

export const LIVE_COOKIE = "sakina_live";
export const LIVE_DURATION_SECONDS = 240;
export type LiveGrant = { sessionId: string; expiresAt: number; nonce: string };

export function signingSecret() {
  const secret = process.env.LIVE_SESSION_SECRET;
  if (!secret || secret.length < 32 || secret === process.env.INTERNAL_API_TOKEN)
    throw new HttpError(503, "المحادثة الصوتية قيد الإعداد. حاول لاحقًا.");
  return secret;
}

export function signGrant(
  sessionId: string,
  expiresAt: number,
  secret: string,
) {
  const grant: LiveGrant = { sessionId, expiresAt, nonce: randomUUID() };
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyGrant(
  token: string,
  sessionId: string,
  secret: string,
  now = Date.now(),
  closing = false,
): LiveGrant {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || token.length > 2048)
    throw new HttpError(401, "انتهت صلاحية الاتصال. ابدأ جلسة جديدة.");
  const expected = createHmac("sha256", secret).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new HttpError(401, "تعذّر التحقق من الاتصال.");
  let grant: LiveGrant;
  try {
    grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(401, "تعذّر التحقق من الاتصال.");
  }
  if (
    grant.sessionId !== sessionId ||
    typeof grant.nonce !== "string" ||
    !Number.isFinite(grant.expiresAt) ||
    grant.expiresAt + (closing ? 60_000 : 0) <= now
  )
    throw new HttpError(401, "انتهت صلاحية الاتصال. ابدأ جلسة جديدة.");
  return grant;
}

export function grantFromRequest(
  request: Request,
  sessionId: string,
  closing = false,
) {
  const token =
    request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${LIVE_COOKIE}=`))
      ?.slice(LIVE_COOKIE.length + 1) || "";
  return verifyGrant(token, sessionId, signingSecret(), Date.now(), closing);
}

export function cookieHeader(token: string) {
  return `${LIVE_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/live; Max-Age=${LIVE_DURATION_SECONDS + 60}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function verifyOrigin(request: Request) {
  const expected = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (
    !origin ||
    origin !== expected ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new HttpError(403, "مصدر الطلب غير مسموح.");
}

export async function readLiveBody<T>(
  request: Request,
  schema: ZodType<T>,
  maxBytes = 32_768,
): Promise<T> {
  verifyOrigin(request);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new HttpError(415, "صيغة الطلب غير مدعومة.");
  if (Number(request.headers.get("content-length") || 0) > maxBytes)
    throw new HttpError(413, "الطلب أطول من الحد المسموح.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "الطلب فارغ.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "الطلب أطول من الحد المسموح.");
    }
    chunks.push(value);
  }
  let input: unknown;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "تعذّر قراءة الطلب.");
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new HttpError(400, "تحقق من المدخلات وحاول مرة أخرى.");
  return parsed.data;
}
