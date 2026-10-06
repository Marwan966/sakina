import assert from "node:assert/strict";
import { test } from "node:test";
import { reserveVoiceBudget } from "../apps/sakina/lib/voice-budget";

test("voice budget fails closed and sends only a daily pseudonym to the quota service", async () => {
  const before = { ...process.env };
  const originalFetch = globalThis.fetch;
  try {
    process.env.NODE_ENV = "production";
    process.env.VERCEL = "1";
    delete process.env.INTERNAL_API_TOKEN;
    delete process.env.SUPABASE_URL;
    const request = new Request("https://sakina.example/api/live/session", {
      headers: { "x-vercel-forwarded-for": "203.0.113.11" },
    });
    await assert.rejects(reserveVoiceBudget(request), { status: 503 });
    process.env.INTERNAL_API_TOKEN = "s".repeat(48);
    process.env.SUPABASE_URL = "https://database.example";
    await assert.rejects(reserveVoiceBudget(new Request(request.url)), {
      status: 503,
    });
    let calls = 0;
    globalThis.fetch = (async (url, options) => {
      calls++;
      assert.equal(url, "https://database.example/functions/v1/voice-budget");
      const data = JSON.parse(String(options?.body));
      assert.deepEqual(Object.keys(data), ["clientHash"]);
      assert.match(data.clientHash, /^[a-f0-9]{64}$/);
      assert.ok(!String(options?.body).includes("203.0.113.11"));
      return Response.json({ allowed: true });
    }) as typeof fetch;
    await reserveVoiceBudget(request);
    assert.equal(calls, 1);
    globalThis.fetch = (async () =>
      Response.json({ allowed: false }, { status: 429 })) as typeof fetch;
    await assert.rejects(reserveVoiceBudget(request), { status: 429 });
    globalThis.fetch = (async () => {
      throw new Error("secret provider details");
    }) as typeof fetch;
    await assert.rejects(reserveVoiceBudget(request), (error: unknown) => {
      assert.equal((error as { status: number }).status, 503);
      assert.ok(!(error as Error).message.includes("secret"));
      return true;
    });
    globalThis.fetch = (async () =>
      Response.json({ allowed: false })) as typeof fetch;
    await assert.rejects(reserveVoiceBudget(request), { status: 503 });
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env))
      if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
});
