/** Verify a high-entropy server credential without any database request. */
export async function internalAuthorized(
  request: Request,
  expectedHash: string | undefined,
) {
  const secret = request.headers.get("x-internal-key");
  if (
    !expectedHash ||
    !/^[a-f0-9]{64}$/.test(expectedHash) ||
    !secret ||
    secret.length < 40 ||
    secret.length > 200
  )
    return false;
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
  );
  const expected = Uint8Array.from(expectedHash.match(/../g)!, (pair) =>
    parseInt(pair, 16),
  );
  let difference = 0;
  for (let i = 0; i < bytes.length; i++) difference |= bytes[i] ^ expected[i];
  return difference === 0;
}
export async function boundedJson(
  request: Request,
  maximum: number,
): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new Error("content_type");
  if (Number(request.headers.get("content-length")) > maximum)
    throw new Error("oversize");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("empty");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > maximum) {
      await reader.cancel();
      throw new Error("oversize");
    }
    chunks.push(part.value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of chunks) {
    result.set(part, offset);
    offset += part.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result));
}
export const reply = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
export type EdgeEnvironment = { get(name: string): string | undefined };
