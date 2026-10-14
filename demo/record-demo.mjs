import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { dirname, resolve } from 'node:path';

import { chromium } from 'playwright';

import { AgentPayPalController } from '../src/agent_paypal_controller.mjs';
import { InMemoryPayPalClient } from '../src/paypal_client.mjs';
import { SimulatedIntentAdapter } from '../src/simulated_adapter.mjs';
import { ScopeGuardService } from '../src/scopeguard_service.mjs';
import { createScopeGuardServer } from '../src/server.mjs';
import { JsonFileStateStore } from '../src/state_store.mjs';

const root = resolve(import.meta.dirname, '..');
const outputPath = resolve(root, 'demo/scopeguard-demo.webm');
const metadataPath = resolve(root, 'demo/recording-metadata.json');
const stateDirectory = await mkdtemp(resolve(os.tmpdir(), 'scopeguard-demo-'));
const stateStore = new JsonFileStateStore(resolve(stateDirectory, 'state.json'));
const categories = ['AI_INFERENCE', 'CLOUD_COMPUTE', 'DEVELOPER_TOOLS', 'DATA_FEEDS'];
const client = new InMemoryPayPalClient();
const controller = new AgentPayPalController({
  agentId: 'scopeguard-demo-agent',
  maxPerTransactionMinor: 2_500,
  maxWindowMinor: 10_000,
  allowedMerchantCategories: categories,
  client,
  stateStore,
});
const service = new ScopeGuardService({
  controller,
  intentAdapter: new SimulatedIntentAdapter({
    allowedCurrencies: ['USD'],
    allowedMerchantCategories: categories,
  }),
});
const port = await new Promise((resolvePort, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const selectedPort = probe.address().port;
    probe.close((error) => error ? reject(error) : resolvePort(selectedPort));
  });
});
const baseUrl = `http://127.0.0.1:${port}`;
const server = createScopeGuardServer({
  service,
  controller,
  appBaseUrl: baseUrl,
  runtimeMode: 'simulation',
});
server.listen(port, '127.0.0.1');
await new Promise((resolveReady, reject) => {
  server.once('listening', resolveReady);
  server.once('error', reject);
});

const browserCandidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  chromium.executablePath(),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const executablePath = browserCandidates.find(existsSync);
if (!executablePath) throw new Error('No Chromium-compatible browser found');

async function waitForResultText(expected) {
  await page.locator('#result').waitFor();
  try {
    await page.waitForFunction(
      (value) => document.querySelector('#result')?.textContent?.includes(value),
      expected,
      { timeout: 10_000 },
    );
  } catch (error) {
    const observed = await page.locator('#result').innerText();
    throw new Error(`Expected result text ${expected}; observed: ${observed}`, { cause: error });
  }
}

await mkdir(dirname(outputPath), { recursive: true });
let browser;
let context;
let page;
let video;

try {
  browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--window-size=1440,900', '--hide-scrollbars', '--force-device-scale-factor=1'],
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    recordVideo: { dir: dirname(outputPath), size: { width: 1440, height: 900 } },
  });
  page = await context.newPage();
  const recordingStartedAt = performance.now();
  await page.setViewportSize({ width: 1440, height: 900 });
  video = page.video();

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByText('Mode: local simulation').waitFor();

  // Chromium can record its initial compositor surface at 1280x720 until the
  // first interaction. Warm it up, reload clean state, then trim this lead-in.
  await page.getByRole('button', { name: /Valid: \$12\.00 AI Inference/ }).click();
  await page.waitForTimeout(750);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('Mode: local simulation').waitFor();
  await page.evaluate(() => {
    history.scrollRestoration = 'manual';
    window.scrollTo(0, 0);
  });
  await page.setViewportSize({ width: 1439, height: 899 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(750);
  const trimStartSeconds = (performance.now() - recordingStartedAt) / 1000;
  await writeFile(metadataPath, `${JSON.stringify({ trimStartSeconds }, null, 2)}\n`);

  await page.waitForTimeout(9_000);

  await page.getByRole('button', { name: /Valid: \$12\.00 AI Inference/ }).click();
  await page.getByRole('button', { name: 'Extract intent and check policy' }).click();
  await waitForResultText('PENDING_BUYER_APPROVAL');
  await page.waitForTimeout(14_000);

  await page.getByRole('link', { name: /Continue to simulated buyer approval/ }).click();
  await page.getByRole('heading', { name: 'Buyer approval returned' }).waitFor();
  await page.waitForTimeout(7_000);

  client.failAfterNextCapture = true;
  await page.getByRole('button', { name: 'Capture approved order' }).click();
  await waitForResultText('CAPTURE_OUTCOME_UNCERTAIN');
  await page.waitForTimeout(15_000);

  await page.getByRole('button', { name: 'Check authoritative order status' }).click();
  await page.getByRole('heading', { name: 'Reconciliation result' }).waitFor();
  await waitForResultText('COMPLETED');
  await page.waitForTimeout(10_000);

  await page.getByRole('button', { name: /Overdraw/ }).click();
  await page.getByRole('button', { name: 'Extract intent and check policy' }).click();
  await waitForResultText('EXCEEDS_PER_TRANSACTION_LIMIT');
  await page.waitForTimeout(6_000);

  await page.getByRole('button', { name: /Prohibited Merchant Category/ }).click();
  await page.getByRole('button', { name: 'Extract intent and check policy' }).click();
  await waitForResultText('MERCHANT_CATEGORY_NOT_PERMITTED');
  await page.waitForTimeout(7_000);

  await page.getByRole('heading', { name: 'Live Spend & Policy Audit Trail' }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(22_000);
} finally {
  if (page) await page.close();
  if (video) await video.saveAs(outputPath);
  if (context) await context.close();
  if (browser) await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(stateDirectory, { recursive: true, force: true });
}

console.log(`Saved ScopeGuard demo recording to ${outputPath}`);
