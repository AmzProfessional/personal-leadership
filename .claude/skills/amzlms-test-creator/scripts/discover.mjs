/**
 * One-time calibration pass against the real LMS.
 *
 * We cannot know amzlms.com's markup ahead of time, so instead of guessing
 * forever this script opens the create-test form, dumps every interactive
 * element it can see, and reports which of the configured field hints actually
 * resolved (and by which strategy). The output is meant to be read by a human
 * or by Claude, and turned into exact `css` overrides in config/selectors.json.
 *
 *   node scripts/discover.mjs                     # inventory the create-test form
 *   node scripts/discover.mjs --stage question    # inventory the question editor
 *   node scripts/discover.mjs --out report.json
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch, loadConfig, gotoAuthenticated, settle, parseArgs, SKILL_ROOT } from './browser.mjs';
import { resolve } from './dom.mjs';

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.config);
const stage = args.stage ?? 'test';
const outPath = path.resolve(args.out ?? path.join(SKILL_ROOT, 'discovery-report.json'));

/** Snapshot every control on the page, with enough context to identify it. */
async function inventory(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const label = (el) => {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return l.innerText.trim();
      }
      const wrap = el.closest('label');
      if (wrap) return wrap.innerText.trim();
      let node = el;
      for (let i = 0; i < 4 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const l = node.querySelector('label, legend');
        if (l) return l.innerText.trim();
      }
      return null;
    };
    // A stable-ish CSS path: prefer id / test id, else tag + nth-of-type chain.
    const cssPath = (el) => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      for (const attr of ['data-testid', 'data-test', 'data-qa', 'formcontrolname', 'name']) {
        const v = el.getAttribute(attr);
        if (v) return `${el.tagName.toLowerCase()}[${attr}="${v}"]`;
      }
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 5) {
        let part = node.tagName.toLowerCase();
        const cls = (node.className || '')
          .toString()
          .split(/\s+/)
          .filter((c) => c && !/\d{4,}|^ng-|^is-|^v-|hash/.test(c))
          .slice(0, 2);
        if (cls.length) part += '.' + cls.join('.');
        const siblings = node.parentElement ? Array.from(node.parentElement.children).filter((s) => s.tagName === node.tagName) : [];
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(' > ');
    };

    const out = { controls: [], buttons: [], headings: [] };
    for (const el of document.querySelectorAll(
      'input:not([type=hidden]), textarea, select, [contenteditable="true"], .ql-editor, .ProseMirror, [role="combobox"], [role="checkbox"], [role="radio"]',
    )) {
      if (!visible(el)) continue;
      out.controls.push({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        role: el.getAttribute('role'),
        label: label(el),
        placeholder: el.getAttribute('placeholder'),
        ariaLabel: el.getAttribute('aria-label'),
        testId: el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa'),
        formControlName: el.getAttribute('formcontrolname'),
        name: el.getAttribute('name'),
        id: el.id || null,
        css: cssPath(el),
      });
    }
    for (const el of document.querySelectorAll('button, [role="button"], a.btn, .btn, input[type=submit]')) {
      if (!visible(el)) continue;
      const text = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ');
      if (!text) continue;
      out.buttons.push({ text, disabled: el.disabled === true, css: cssPath(el) });
    }
    for (const el of document.querySelectorAll('h1,h2,h3,h4,legend,[role="heading"]')) {
      if (!visible(el)) continue;
      const text = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (text) out.headings.push(text);
    }
    return out;
  });
}

/** Report which configured hints resolve, and how robustly. */
async function probe(page, fields) {
  const results = {};
  for (const [name, spec] of Object.entries(fields)) {
    const hit = await resolve(page, spec, { timeout: 400 });
    results[name] = hit ? { found: true, strategy: hit.strategy } : { found: false };
  }
  return results;
}

const main = async () => {
  const { context, page } = await launch({ headless: false, slowMo: 60 });
  const report = { stage, url: config.urls.knowledge, capturedAt: new Date().toISOString(), steps: {} };

  try {
    await gotoAuthenticated(page, config.urls.knowledge);
    report.steps.knowledgePage = await inventory(page);

    const createBtn = await resolve(page, config.fields.createTestButton);
    if (!createBtn) {
      report.steps.error =
        'Кнопку "Створити тест" не знайдено. Дивіться steps.knowledgePage.buttons — там перелічено всі кнопки на сторінці.';
    } else {
      await createBtn.locator.click();
      await settle(page, 1200);
      report.steps.createTestForm = await inventory(page);
      report.steps.createTestFormProbe = await probe(page, config.fields);

      if (stage === 'question') {
        const addQ = await resolve(page, config.fields.addQuestionButton);
        if (!addQ) {
          report.steps.questionError =
            'Кнопку "Додати питання" не знайдено на формі створення тесту. Можливо, тест треба спершу зберегти.';
        } else {
          await addQ.locator.click();
          await settle(page, 1200);
          report.steps.questionEditor = await inventory(page);
          report.steps.questionEditorProbe = await probe(page, config.fields);
        }
      }
    }
  } catch (err) {
    report.steps.exception = String(err.message ?? err);
  }

  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  // Console summary — the JSON has everything, but this is what you skim first.
  const probeResult = report.steps.questionEditorProbe ?? report.steps.createTestFormProbe ?? {};
  console.log(`\nЗвіт збережено: ${outPath}\n`);
  if (Object.keys(probeResult).length) {
    console.log('Розпізнані поля:');
    for (const [name, r] of Object.entries(probeResult)) {
      console.log(`  ${r.found ? '✓' : '✗'} ${name.padEnd(22)} ${r.found ? r.strategy : '— НЕ ЗНАЙДЕНО'}`);
    }
  }
  const inv = report.steps.questionEditor ?? report.steps.createTestForm ?? report.steps.knowledgePage;
  if (inv) {
    console.log('\nКнопки на сторінці:');
    for (const b of inv.buttons.slice(0, 25)) console.log(`  "${b.text}"  ->  ${b.css}`);
    console.log('\nПоля вводу:');
    for (const c of inv.controls.slice(0, 40)) {
      console.log(`  [${c.tag}${c.type ? `:${c.type}` : ''}] label=${JSON.stringify(c.label)} ph=${JSON.stringify(c.placeholder)}  ->  ${c.css}`);
    }
  }
  console.log('\nБраузер залишається відкритим — закрийте вікно, коли завершите огляд.');

  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
  await context.close().catch(() => {});
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
