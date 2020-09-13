#!/usr/bin/env node
import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';

function onConsole(msg) {
  const type = msg.type();
  const prefix = type === 'log' ? '' : `[${type}] `;
  console.log(prefix + msg.text());
}

function terminate(browser, status = 0) {
  browser.close();
  process.exit(status);
}

function browserPath() {
  const choices = ['/usr/bin/chromium', '/usr/bin/chrome'];
  for (const choice of choices) {
    if (fs.existsSync(choice)) {
      return choice;
    }
  }
  throw new Error('no chrome or chromium binary found');
}

async function main() {
  const start = Date.now();
  const timeout = 5000;
  const uri = `file://${path.resolve('test/index.html')}`;

  const binary = browserPath();
  const browser = await puppeteer.launch({
    args: ['--allow-file-access-from-files'],
    executablePath: binary,
  });

  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(timeout);
  page.on('console', onConsole);

  const timer = setTimeout(() => {
    console.error('Timeout - aborting tests.');
    terminate(browser, 1);
  }, timeout);

  let resolveRunEnd;
  const runEnd = new Promise(async (resolve, reject) => {
    resolveRunEnd = resolve;
  });
  await page.exposeFunction('HARNESS_RUN_END', (data) => resolveRunEnd(data));
  await page.goto(uri);

  const { testCounts, runtime } = await runEnd;
  clearTimeout(timer);

  const success = testCounts.failed === 0;
  const prefix = success
    ? `✓ passed ${testCounts.passed}`
    : `✗ failed ${testCounts.failed}`;
  const duration = Date.now() - start;
  console.error(
    `${prefix} / ${testCounts.total} (tests: ${Math.floor(
      runtime,
    )}ms / total: ${duration}ms)`,
  );

  terminate(browser, success ? 0 : 1);
}

main().catch((err) => {
  throw err;
});
