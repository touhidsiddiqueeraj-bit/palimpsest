import { expect, test } from '@playwright/test';

test('app boots and renders the shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Palimpsest' })).toBeVisible();
});
