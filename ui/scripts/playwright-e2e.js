import { chromium } from 'playwright';

const baseUrl = process.env.UI_URL || 'http://127.0.0.1:5175';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const response = await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) {
    throw new Error(`page load failed ${response?.status()}`);
  }
  console.log('E2E проверка прошла');
} catch (error) {
  console.error('E2E тест упал:', error);
  process.exit(1);
} finally {
  await browser.close();
}
