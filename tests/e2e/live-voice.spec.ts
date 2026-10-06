import { test, expect } from "@playwright/test";

const sakina = process.env.SAKINA_URL || "http://localhost:3000";

test("Sakina is a public voice page with a usable start and no text-search form", async ({
  page,
}) => {
  await page.goto(sakina);
  await expect(
    page.getByRole("button", { name: "ابدأ الحديث", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('textarea,input[type="text"],input[type="password"]'),
  ).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByText("خصوصيتك وحدود المساعدة", { exact: true }).click();
  await expect(page.locator("#privacy")).toHaveAttribute("open", "");
  await expect(page.locator("#privacy")).toContainText(
    "لا نطلب اسمك أو حسابًا",
  );
});

test("Microphone refusal gives an actionable retry without creating a paid session", async ({
  page,
}) => {
  let starts = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/live/session")) starts++;
  });
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  await page.goto(sakina);
  await page.getByRole("button", { name: "ابدأ الحديث", exact: true }).click();
  await expect(page.locator(".call-error")).toContainText(
    "اسمح باستخدام الميكروفون",
  );
  await expect(
    page.getByRole("button", { name: "حاول الاتصال مجددًا" }),
  ).toBeVisible();
  expect(starts).toBe(0);
});

test("Live API rejects cross-origin, unconsented, extra-field and unowned requests before provider work", async ({
  request,
}) => {
  const sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
  const base = `${sakina}/api/live`;
  expect(
    (
      await request.post(`${base}/session`, {
        headers: { Origin: "https://untrusted.example" },
        data: { sdp, consent: true },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post(`${base}/session`, { data: { sdp, consent: true } })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post(`${base}/session`, {
        headers: { Origin: sakina },
        data: { sdp, consent: false },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await request.post(`${base}/session`, {
        headers: { Origin: sakina },
        data: { sdp, consent: true, model: "attacker" },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await request.post(`${base}/control`, {
        headers: { Origin: sakina },
        data: { sessionId: "live_unowned", action: "end" },
      })
    ).status(),
  ).toBe(401);
});

test("Sakina only enables the same-origin microphone and does not send referrers to the reciter CDN", async ({
  request,
}) => {
  const response = await request.get(sakina);
  expect(response.headers()["permissions-policy"]).toContain(
    "microphone=(self)",
  );
  expect(response.headers()["permissions-policy"]).toContain("camera=()");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
});
