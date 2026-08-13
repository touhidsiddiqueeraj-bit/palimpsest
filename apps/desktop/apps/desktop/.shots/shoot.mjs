import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('file:///home/touhid/Documents/markdown/reference/v0-single-file-prototype.html');
await page.waitForTimeout(1800);
await page.screenshot({ path: '/home/touhid/Documents/markdown/docs/media/app-v0.png' });
console.log('v0 shot done');
await browser.close();
