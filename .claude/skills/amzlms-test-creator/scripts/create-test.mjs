/**
 * Create a test in the LMS from a questions file, one question at a time.
 *
 *   node scripts/create-test.mjs questions.md --dry-run
 *   node scripts/create-test.mjs questions.md
 *   node scripts/create-test.mjs questions.md --resume
 *   node scripts/create-test.mjs questions.md --base-url https://amzlms.com/#/knowledge
 *
 * Design notes worth knowing before you change anything here:
 *
 * - Validation runs fully before the browser opens. Discovering on question 34
 *   that question 35 has no correct answer marked means a half-created test in
 *   production, so everything that can be checked offline is checked offline.
 * - Progress is written to disk after every saved question. A network blip on
 *   question 20 of 40 should cost you 20 questions, not 40, and `--resume`
 *   picks up where it stopped.
 * - On any failure the browser stays open with a screenshot saved. The point is
 *   to let you finish the last step by hand rather than roll back work the LMS
 *   has already committed.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseTest, formatReport } from './parse-questions.mjs';
import { launch, loadConfig, gotoAuthenticated, settle, parseArgs, SKILL_ROOT } from './browser.mjs';
import { resolve, mustResolve, setText, chooseOption, ensureChecked } from './dom.mjs';

const args = parseArgs(process.argv.slice(2));
const inputPath = args._[0] ?? args.input;

if (!inputPath || args.help) {
  console.log(`
Використання:
  node scripts/create-test.mjs <файл.md|файл.json> [опції]

Опції:
  --dry-run           Тільки перевірити файл і показати план. Браузер не відкривається.
  --resume            Продовжити з місця, де попередній запуск зупинився.
  --start-at N        Почати з питання N (1-based), ігноруючи збережений прогрес.
  --headless          Без вікна браузера (тільки якщо ви вже входили в LMS раніше).
  --slow-mo MS        Затримка між діями, зручно для спостереження. За замовч. 40.
  --base-url URL      Перевизначити сторінку бази знань.
  --config PATH       Інший файл селекторів.
  --keep-open         Не закривати браузер після завершення.
`);
  process.exit(inputPath ? 0 : 1);
}

const config = loadConfig(args.config);
const raw = readFileSync(inputPath, 'utf8');
const parsed = parseTest(raw, path.extname(inputPath).toLowerCase() === '.json' ? 'json' : 'md');
const { test, errors } = parsed;

console.log('\n=== План створення тесту ===');
console.log(formatReport(parsed));
console.log('============================\n');

if (errors.length) {
  console.error('Файл містить помилки — нічого не створено. Виправте їх і запустіть знову.');
  process.exit(1);
}
if (args['dry-run']) {
  console.log('Режим перевірки (--dry-run): браузер не відкривався, у LMS нічого не створено.');
  process.exit(0);
}

const workDir = path.join(SKILL_ROOT, '.runs');
mkdirSync(workDir, { recursive: true });
const progressPath = path.join(workDir, `${path.basename(inputPath)}.progress.json`);

function readProgress() {
  if (!existsSync(progressPath)) return null;
  try {
    return JSON.parse(readFileSync(progressPath, 'utf8'));
  } catch {
    return null;
  }
}
function writeProgress(data) {
  writeFileSync(progressPath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * The question editor usually opens in a modal. Scoping to it keeps "Зберегти"
 * from matching a button on the page behind the overlay.
 */
async function editorScope(page) {
  const dialog = page.locator('[role="dialog"], .modal.show, .modal[style*="display: block"], .ant-modal-content, .mat-dialog-container, .p-dialog').last();
  return (await dialog.count()) && (await dialog.isVisible().catch(() => false)) ? dialog : page;
}

/** Locate the repeated answer rows, falling back to "inputs that look like answers". */
async function optionRows(page, scope) {
  for (const css of [].concat(config.fields.optionRow?.css ?? [])) {
    const rows = scope.locator(css);
    if (await rows.count()) return rows;
  }
  const ph = [].concat(config.fields.optionInput?.placeholder ?? []);
  for (const p of ph) {
    const inputs = scope.getByPlaceholder(p, { exact: false });
    if (await inputs.count()) return inputs;
  }
  return null;
}

async function fillTestMetadata(page) {
  const f = config.fields;

  const title = await mustResolve(page, f.title, 'title');
  await setText(title.locator, test.title);
  console.log(`  ✓ назва          (${title.strategy})`);

  if (test.description) {
    const d = await resolve(page, f.description);
    if (d) {
      await setText(d.locator, test.description);
      console.log(`  ✓ опис           (${d.strategy})`);
    } else {
      console.log('  ! опис — поле не знайдено, пропущено');
    }
  }

  if (test.category) {
    const c = await resolve(page, f.category);
    if (c) {
      const how = await chooseOption(page, c.locator, test.category);
      console.log(`  ✓ категорія      (${c.strategy} / ${how})`);
    } else {
      console.log('  ! категорія — поле не знайдено, пропущено');
    }
  }

  for (const dept of test.departments) {
    const d = await resolve(page, f.departments);
    if (!d) {
      console.log('  ! департамент — поле не знайдено, пропущено');
      break;
    }
    const how = await chooseOption(page, d.locator, dept);
    console.log(`  ✓ департамент "${dept}" (${how})`);
    await page.keyboard.press('Escape').catch(() => {});
  }

  const pass = await resolve(page, f.passingScore);
  if (pass) {
    await setText(pass.locator, String(test.passingScore));
    console.log(`  ✓ прохідний бал ${test.passingScore} (${pass.strategy})`);
  } else {
    console.log('  ! прохідний бал — поле не знайдено, пропущено');
  }

  const time = await resolve(page, f.timeLimit);
  if (time) {
    await setText(time.locator, String(test.timeLimit));
    console.log(`  ✓ час ${test.timeLimit} хв (${time.strategy})`);
  } else {
    console.log('  ! час — поле не знайдено, пропущено');
  }
}

async function addQuestion(page, question, index) {
  const f = config.fields;

  const addBtn = await mustResolve(page, f.addQuestionButton, 'addQuestionButton');
  await addBtn.locator.click();
  await settle(page, 900);

  const scope = await editorScope(page);

  // Question type first: some editors swap the answer widgets when it changes,
  // which would wipe anything already typed.
  const typeSpec = question.type === 'multiple' ? f.questionTypeMultiple : f.questionTypeSingle;
  const typeHit = await resolve(page, typeSpec, { scope });
  if (typeHit) {
    await ensureChecked(typeHit.locator);
  } else {
    console.log(`    ! тип "${question.type}" не знайдено — залишено значення за замовчуванням`);
  }
  await settle(page, 400);

  const qText = await mustResolve(page, f.questionText, 'questionText', { scope });
  await setText(qText.locator, question.text);

  // Make sure there are enough answer rows before filling any of them.
  let rows = await optionRows(page, scope);
  const needed = question.options.length;
  let have = rows ? await rows.count() : 0;
  const addOption = await resolve(page, f.addOptionButton, { scope });
  let guard = 0;
  while (have < needed && addOption && guard++ < 20) {
    await addOption.locator.click();
    await settle(page, 250);
    rows = await optionRows(page, scope);
    have = rows ? await rows.count() : 0;
  }
  if (!rows || have < needed) {
    throw new Error(
      `Питання #${index + 1}: потрібно ${needed} варіантів відповіді, а на формі доступно ${have}. ` +
        'Перевірте fields.optionRow / fields.addOptionButton у config/selectors.json.',
    );
  }

  for (let i = 0; i < needed; i++) {
    const row = rows.nth(i);
    const isInput = await row.evaluate((el) => ['input', 'textarea'].includes(el.tagName.toLowerCase()) || el.isContentEditable).catch(() => false);

    const input = isInput
      ? row
      : row.locator('input[type="text"], input:not([type]), textarea, [contenteditable="true"]').first();
    await setText(input, question.options[i].text);

    if (question.options[i].correct) {
      // When the row *is* the input there is no row container to search, so look
      // for the toggle among the input's siblings instead.
      const container = isInput ? row.locator('xpath=..') : row;
      const toggle = container.locator('input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"]').first();
      if (await toggle.count()) await ensureChecked(toggle);
      else console.log(`    ! варіант ${i + 1}: не знайдено позначку "правильна відповідь"`);
    }
  }

  if (question.explanation) {
    const exp = await resolve(page, f.explanation, { scope });
    if (exp) await setText(exp.locator, question.explanation);
    else console.log('    ! поле пояснення не знайдено, пропущено');
  }

  const saveBtn = await mustResolve(page, f.saveQuestionButton, 'saveQuestionButton', { scope });
  await saveBtn.locator.click();
  await settle(page, config.options.questionSaveWaitMs ?? 700);
}

const main = async () => {
  const { context, page } = await launch({
    headless: Boolean(args.headless),
    slowMo: Number(args['slow-mo'] ?? 40),
  });

  const saved = args.resume ? readProgress() : null;
  const startAt = args['start-at'] ? Number(args['start-at']) - 1 : (saved?.lastCompleted ?? -1) + 1;
  let failure = null;

  try {
    const url = args['base-url'] ?? config.urls.knowledge;
    await gotoAuthenticated(page, url, { headless: Boolean(args.headless) });

    if (startAt > 0) {
      console.log(
        `Продовження з питання #${startAt + 1}. Відкрийте потрібний тест у режимі редагування ` +
          'і натисніть Enter у цьому вікні, коли будете готові.',
      );
      await new Promise((r) => process.stdin.once('data', r));
    } else {
      console.log('Створення тесту...');
      const createBtn = await mustResolve(page, config.fields.createTestButton, 'createTestButton');
      await createBtn.locator.click();
      await settle(page, 1200);

      await fillTestMetadata(page);

      // Some LMS builds expose "Додати питання" straight away; others require
      // the test to be saved first. Try questions, save only if we have to.
      if (!(await resolve(page, config.fields.addQuestionButton, { timeout: 800 }))) {
        const saveTest = await resolve(page, config.fields.saveTestButton);
        if (saveTest) {
          await saveTest.locator.click();
          await settle(page, 1500);
          console.log('  ✓ тест збережено');
        }
      }
    }

    console.log(`\nДодавання питань (${test.questions.length - startAt} з ${test.questions.length})...`);
    for (let i = Math.max(0, startAt); i < test.questions.length; i++) {
      const q = test.questions[i];
      process.stdout.write(`  [${i + 1}/${test.questions.length}] ${q.text.slice(0, 60)}${q.text.length > 60 ? '…' : ''} `);
      await addQuestion(page, q, i);
      writeProgress({ input: inputPath, title: test.title, lastCompleted: i, at: new Date().toISOString() });
      console.log('✓');
    }

    console.log(`\nГотово: додано ${test.questions.length - Math.max(0, startAt)} питань до тесту "${test.title}".`);
    console.log('Перевірте тест у LMS і опублікуйте його вручну, якщо потрібно.');
  } catch (err) {
    failure = err;
    const shot = path.join(workDir, `error-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.error(`\n✗ Помилка: ${err.message}`);
    console.error(`  Знімок екрана: ${shot}`);
    console.error('  Браузер залишається відкритим — можна завершити крок вручну.');
    console.error(`  Після виправлення продовжіть: node scripts/create-test.mjs ${inputPath} --resume`);
  }

  if (failure || args['keep-open']) {
    await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
  }
  await context.close().catch(() => {});
  if (failure) process.exit(1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
