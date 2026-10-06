import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const sakina = process.env.SAKINA_URL || "http://localhost:3000";

test('Retired Sakina text routes and current voice health', async ({ request }) => {
  expect((await request.post(sakina + '/api/search', { data: { text: 'ضغط العمل' } })).status()).toBe(410);
  expect((await request.get(sakina + '/api/catalog')).status()).toBe(410);
  const response = await request.get(sakina + '/api/health');
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({experience:'voice',voiceModel:'gpt-live-1',accountRequired:false});
});

test("Sakina mobile homepage fit viewport and have no runtime errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  for (const url of [sakina]) {
    await page.goto(url);
    await expect(page.locator("h1").first()).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    await page.keyboard.press("Tab");
  }
  expect(errors).toEqual([]);
});

test("Sakina meets automated WCAG A/AA checks", async ({ page }) => {
  for (const url of [sakina]) {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      results.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => n.target),
      })),
    ).toEqual([]);
  }
});
