import { test, expect } from '@playwright/test';

/**
 * Smoke test only. Requires a running instance of this app (server + real/local DynamoDB +
 * built web console) reachable at E2E_BASE_URL (defaults to http://localhost:3000 — see
 * playwright.config.ts). Not run automatically in this environment or in CI without that
 * setup — see docs/TESTING.md for how to stand up a local instance first.
 */
test('the People console shell loads at /console/', async ({ page }) => {
  await page.goto('/console/');
  await expect(page).toHaveTitle(/Performance Reviews|People Console/i);
});
