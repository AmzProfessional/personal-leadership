/**
 * Browser session management.
 *
 * The LMS is behind a login, and asking for credentials in a config file is
 * both fragile and a bad idea. Instead we use a persistent Chromium profile
 * under ~/.amzlms-automation: you log in by hand once, the session cookie
 * survives in that profile, and every later run starts already authenticated.
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILE_DIR = process.env.AMZLMS_PROFILE ?? path.join(homedir(), '.amzlms-automation', 'profile');

export function loadConfig(overridePath) {
  const custom = overridePath ?? path.join(SKILL_ROOT, 'config', 'selectors.json');
  const base = JSON.parse(readFileSync(path.join(SKILL_ROOT, 'config', 'selectors.default.json'), 'utf8'));
  if (!existsSync(custom)) return base;

  const user = JSON.parse(readFileSync(custom, 'utf8'));
  // Shallow-merge per section so a user file can override one field without
  // having to restate the whole default map.
  return {
    ...base,
    ...user,
    urls: { ...base.urls, ...(user.urls ?? {}) },
    fields: { ...base.fields, ...(user.fields ?? {}) },
    options: { ...base.options, ...(user.options ?? {}) },
  };
}

export async function launch({ headless = false, slowMo = 0, profileDir = PROFILE_DIR } = {}) {
  mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    slowMo,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(15000);
  return { context, page };
}

/**
 * Navigate and make sure we are actually logged in.
 *
 * A hash-routed SPA answers 200 for every URL, so HTTP status tells us nothing;
 * the reliable signal is whether the router parked us on a login route. When it
 * did, we stop and wait for a human rather than trying to guess a login form.
 */
export async function gotoAuthenticated(page, url, { loginTimeout = 300000, headless = false } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const onLogin = async () =>
    /\b(login|signin|sign-in|auth)\b/i.test(page.url()) ||
    (await page.locator('input[type="password"]').count()) > 0;

  if (await onLogin()) {
    if (headless) {
      throw new Error(
        'Потрібен вхід у LMS, але браузер запущено у headless-режимі.\n' +
          'Запустіть один раз без --headless, увійдіть вручну — сесія збережеться у профілі.',
      );
    }
    process.stderr.write(
      '\n>> Потрібен вхід у LMS. Увійдіть у вікні браузера, що відкрилося.\n' +
        '   Скрипт продовжить автоматично після входу (очікування до 5 хв).\n\n',
    );
    const deadline = Date.now() + loginTimeout;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      if (!(await onLogin())) break;
    }
    if (await onLogin()) throw new Error('Вхід не завершено — час очікування вичерпано.');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
  }
  await settle(page);
}

/** SPA routes render after the network goes quiet; give it a bounded chance to. */
export async function settle(page, ms = 800) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=');
      if (inline !== undefined) args[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
      else args[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}
