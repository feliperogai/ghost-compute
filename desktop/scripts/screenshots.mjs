// Renders the UI against the mock agent in every scenario (light + dark) for visual review.
// Usage: npm run build && node scripts/screenshots.mjs [outDir]
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdirSync, existsSync } from 'node:fs';

const out = process.argv[2] ?? 'screenshots';
mkdirSync(out, { recursive: true });
const executablePath = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', process.env.CHROME].find(
  (p) => p && existsSync(p),
);

const server = await createServer({ server: { port: 1421, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath });
const scenarios = ['stopped', 'waiting', 'ready', 'running', 'paused', 'hot', 'reconnecting', 'noagent'];

for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme: scheme });
  for (const s of scenarios) {
    await page.goto(`http://localhost:1421/?scenario=${s}`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/${s}-${scheme}.png`, fullPage: true });
  }
  for (const tab of ['Trabalhos', 'Configurações']) {
    await page.goto('http://localhost:1421/?scenario=running');
    await page.getByRole('tab', { name: tab }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/tab-${tab === 'Trabalhos' ? 'jobs' : 'settings'}-${scheme}.png`, fullPage: true });
  }
  await page.close();
}
// Narrow window.
const narrow = await browser.newPage({ viewport: { width: 760, height: 900 } });
await narrow.goto('http://localhost:1421/?scenario=running');
await narrow.waitForTimeout(400);
await narrow.screenshot({ path: `${out}/running-narrow.png`, fullPage: true });

await browser.close();
await server.close();
console.log(`screenshots in ${out}/`);
