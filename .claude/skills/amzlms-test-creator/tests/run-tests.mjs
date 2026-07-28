/**
 * Regression tests for the skill's own machinery.
 *
 * Two layers:
 *   1. Parser tests — pure and fast, no browser.
 *   2. An end-to-end run of create-test.mjs against tests/mock-lms/index.html,
 *      served over real HTTP. The mock mimics the LMS's shapes — custom
 *      dropdowns rather than <select>, a modal question editor, answer rows
 *      added on demand — and POSTs whatever it received back to this harness.
 *      That is how we verify the automation works without writing to production.
 *
 *   node tests/run-tests.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTest } from '../scripts/parse-questions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
};

// ---------------------------------------------------------------- parser ----
console.log('\nПарсер:');
{
  const md = `---
Назва тесту: Персональне лідерство
Опис: Перевірка знань за модулем 1
Категорія: Управління командою
Департаменти: Sales, Support
Прохідний бал: 80
Час: auto
---

## 1. Що таке персональне лідерство?
- [x] Здатність керувати собою
- [ ] Здатність керувати іншими
> Пояснення: починається з себе.

## Оберіть складові лідерства
type: multiple
- [x] Самосвідомість
- [x] Саморегуляція
- [ ] Мікроменеджмент
> Дві перші — базові складові.
`;
  const { test, errors, warnings } = parseTest(md);
  check('без помилок', errors.length === 0, errors.join('; '));
  check('назва', test.title === 'Персональне лідерство', test.title);
  check('категорія', test.category === 'Управління командою', String(test.category));
  check('департаменти', JSON.stringify(test.departments) === '["Sales","Support"]', JSON.stringify(test.departments));
  check('прохідний бал 80', test.passingScore === 80, String(test.passingScore));
  check('час = 2 хв (авто, 2 питання)', test.timeLimit === 2, String(test.timeLimit));
  check('2 питання', test.questions.length === 2, String(test.questions.length));
  check('нумерацію знято із заголовка', test.questions[0].text === 'Що таке персональне лідерство?', test.questions[0].text);
  check('тип 1 виведено як single', test.questions[0].type === 'single', test.questions[0].type);
  check('тип 2 = multiple', test.questions[1].type === 'multiple', test.questions[1].type);
  check('мітку "Пояснення:" знято', test.questions[0].explanation === 'починається з себе.', String(test.questions[0].explanation));
  check('дві правильні у питанні 2', test.questions[1].options.filter((o) => o.correct).length === 2);
  check('без зайвих попереджень', warnings.length === 0, warnings.join('; '));
}

console.log('\nПарсер — виявлення помилок:');
{
  const { errors } = parseTest('---\ntitle: T\n---\n\n## Питання без правильної відповіді\n- [ ] А\n- [ ] Б\n');
  check('ловить відсутність правильної відповіді', errors.some((e) => e.includes('правильної')), errors.join('; '));
}
{
  const { errors } = parseTest('---\ntitle: T\n---\n\n## Питання\ntype: single\n- [x] А\n- [x] Б\n');
  check('ловить конфлікт single + 2 правильні', errors.some((e) => e.includes('single')), errors.join('; '));
}
{
  const { errors } = parseTest('---\ntitle: T\n---\n\n## Питання з одним варіантом\n- [x] А\n');
  check('ловить < 2 варіантів', errors.some((e) => e.includes('2 варіанти')), errors.join('; '));
}
{
  const { errors } = parseTest('## Питання\n- [x] А\n- [ ] Б\n');
  check('ловить відсутню назву тесту', errors.some((e) => e.includes('назву')), errors.join('; '));
}
{
  const { errors } = parseTest('---\ntitle: T\n---\n\n## Питання\n- [x] А\n- [x] А\n');
  check('ловить дубльований варіант', errors.some((e) => e.includes('Дубльований') || e.includes('дубльований')), errors.join('; '));
}
{
  const { test, errors } = parseTest(
    JSON.stringify({
      title: 'JSON тест',
      passingScore: 90,
      timeLimit: 'auto',
      questions: [{ text: 'Питання?', options: [{ text: 'А', correct: true }, { text: 'Б' }] }],
    }),
    'json',
  );
  check('JSON-вхід парситься', errors.length === 0 && test.title === 'JSON тест', errors.join('; '));
  check('JSON: прохідний бал 90', test.passingScore === 90, String(test.passingScore));
}

// ------------------------------------------- формат «як пишуть насправді» ----
console.log('\nСирий формат (метадані без ---, "Питання N.", ✅, "Пояснення:"):');
{
  const raw = `Назва тесту:  Пробний тест
Департаменти: AM
Прохідний бал: 80
Опис: Довгий опис, який
продовжується на наступному рядку.
Питання 1. Перше питання?

* Неправильний варіант
* ✅Правильний без пробілу після галочки
* Ще один неправильний

Пояснення: Пояснення до першого питання.
Питання 2. Друге питання? (декілька вірних відповідей)

* ✅ Перший правильний
* ✅ Другий правильний
* Неправильний

Пояснення: Пояснення до другого.
`;
  const { test, errors } = parseTest(raw);
  check('без помилок', errors.length === 0, errors.join('; '));
  check('метадані без --- зчитано', test.title === 'Пробний тест', test.title);
  check('перенесений рядок опису приєднано', /продовжується на наступному рядку\.$/.test(test.description), test.description);
  check('департамент', JSON.stringify(test.departments) === '["AM"]', JSON.stringify(test.departments));
  check('2 питання', test.questions.length === 2, String(test.questions.length));
  check('префікс "Питання N." прибрано', test.questions[0].text === 'Перше питання?', test.questions[0].text);
  check(
    '✅ без пробілу: позначено правильною',
    test.questions[0].options[1].correct === true,
    JSON.stringify(test.questions[0].options[1]),
  );
  check(
    '✅ прибрано з тексту відповіді',
    test.questions[0].options[1].text === 'Правильний без пробілу після галочки',
    test.questions[0].options[1].text,
  );
  check('жодної ✅ у розібраних даних', !JSON.stringify(test).includes('✅'), JSON.stringify(test).slice(0, 200));
  check('"Пояснення:" розпізнано як пояснення', test.questions[0].explanation === 'Пояснення до першого питання.', String(test.questions[0].explanation));
  check('кілька ✅ -> тип multiple', test.questions[1].type === 'multiple', test.questions[1].type);
  check('питання 2: 2 правильні з 3', test.questions[1].options.filter((o) => o.correct).length === 2, JSON.stringify(test.questions[1].options));
}

console.log('\nСправжня вставка користувача (tests/fixtures/raw-paste.txt):');
{
  const raw = parseTest(readFileSync(path.join(HERE, 'fixtures', 'raw-paste.txt'), 'utf8'));
  check('без помилок', raw.errors.length === 0, raw.errors.join('; '));
  check('24 питання', raw.test.questions.length === 24, String(raw.test.questions.length));
  check('час порахований авто = 24 хв', raw.test.timeLimit === 24, String(raw.test.timeLimit));
  const multi = raw.test.questions.filter((q) => q.type === 'multiple');
  check('4 питання з кількома відповідями', multi.length === 4, String(multi.length));
  check(
    'кількість правильних збігається з ✅ у джерелі',
    JSON.stringify(multi.map((q) => q.options.filter((o) => o.correct).length)) === '[4,5,3,5]',
    JSON.stringify(multi.map((q) => q.options.filter((o) => o.correct).length)),
  );
  check('жодної ✅ у текстах відповідей', !JSON.stringify(raw.test).includes('✅'));
  check('кожне питання має пояснення', raw.test.questions.every((q) => q.explanation), '');
}

// ------------------------------------------------------------------ e2e ----
console.log('\nНаскрізний прогін проти mock-LMS:');

const fixture = `---
Назва тесту: Персональне лідерство — модуль 1
Опис: Підсумкова перевірка знань
Категорія: Управління командою
Департаменти: Sales, Support
Прохідний бал: 80
Час: auto
---

## Що таке персональне лідерство?
- [x] Здатність керувати собою та своїми реакціями
- [ ] Здатність контролювати роботу підлеглих
- [ ] Формальна посада в компанії
> Персональне лідерство починається з управління собою.

## Оберіть складові персонального лідерства
type: multiple
- [x] Самосвідомість
- [x] Саморегуляція
- [x] Проактивність
- [ ] Мікроменеджмент
> Перші три — базові складові моделі.

## Скільки часу відводиться на одне питання?
- [ ] Дві хвилини
- [x] Одна хвилина
> За стандартом — одна хвилина на питання.
`;

const dir = mkdtempSync(path.join(tmpdir(), 'lms-test-'));
const inputFile = path.join(dir, 'questions.md');
writeFileSync(inputFile, fixture, 'utf8');

const dry = spawnSync('node', [path.join(SKILL, 'scripts', 'create-test.mjs'), inputFile, '--dry-run'], {
  encoding: 'utf8',
});
check('--dry-run завершується успішно', dry.status === 0, dry.stderr);
check('--dry-run рахує час автоматично (3 питання -> 3 хв)', /Час:\s+3 хв/.test(dry.stdout), dry.stdout);
check('--dry-run не відкриває браузер', /браузер не відкривався/.test(dry.stdout), dry.stdout);

let received = null;
const html = readFileSync(path.join(HERE, 'mock-lms', 'index.html'), 'utf8');
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__state') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        received = JSON.parse(body);
      } catch {}
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const mockUrl = `http://127.0.0.1:${server.address().port}/#/knowledge`;

// Must be async: the mock server lives in this process, so blocking the event
// loop with spawnSync would stop it from ever answering the browser.
const run = await new Promise((done) => {
  const child = spawn(
    'node',
    [path.join(SKILL, 'scripts', 'create-test.mjs'), inputFile, '--base-url', mockUrl, '--headless', '--slow-mo', '0'],
    { env: { ...process.env, AMZLMS_PROFILE: path.join(dir, 'profile') } },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const kill = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', (status) => {
    clearTimeout(kill);
    done({ status, stdout, stderr });
  });
});
server.close();

check('прогін завершився успішно', run.status === 0, (run.stderr || '') + (run.stdout || '').slice(-1500));

const state = received;
check('mock отримав дані тесту', Boolean(state?.test), JSON.stringify(state));
if (state?.test) {
  check('назва', state.test.title === 'Персональне лідерство — модуль 1', state.test.title);
  check('опис', state.test.description === 'Підсумкова перевірка знань', state.test.description);
  check('категорія (кастомний дропдаун)', state.test.category === 'Управління командою', String(state.test.category));
  check('департаменти (мультивибір)', JSON.stringify(state.test.departments) === '["Sales","Support"]', JSON.stringify(state.test.departments));
  check('прохідний бал перезаписано на 80', state.test.passingScore === 80, String(state.test.passingScore));
  check('час перезаписано на 3', state.test.timeLimit === 3, String(state.test.timeLimit));
}
check('додано 3 питання', state?.questions?.length === 3, String(state?.questions?.length));
if (state?.questions?.length === 3) {
  const [q1, q2, q3] = state.questions;
  check('питання 1: текст', q1.text === 'Що таке персональне лідерство?', q1.text);
  check('питання 1: тип single', q1.type === 'single', q1.type);
  check('питання 1: 3 варіанти (рядок додано динамічно)', q1.options.length === 3, String(q1.options.length));
  check(
    'питання 1: правильна саме перша',
    q1.options.filter((o) => o.correct).map((o) => o.text).join('|') === 'Здатність керувати собою та своїми реакціями',
    JSON.stringify(q1.options),
  );
  check('питання 1: пояснення', q1.explanation === 'Персональне лідерство починається з управління собою.', q1.explanation);
  check('питання 2: тип multiple', q2.type === 'multiple', q2.type);
  check('питання 2: 4 варіанти', q2.options.length === 4, String(q2.options.length));
  check('питання 2: 3 правильні', q2.options.filter((o) => o.correct).length === 3, JSON.stringify(q2.options));
  check('питання 2: "Мікроменеджмент" не позначено', q2.options.at(-1).correct === false, JSON.stringify(q2.options.at(-1)));
  check('питання 3: 2 варіанти, без зайвих порожніх', q3.options.length === 2, JSON.stringify(q3.options));
  check('питання 3: правильна — друга', q3.options[1].correct === true && q3.options[0].correct === false, JSON.stringify(q3.options));
}

console.log(failures === 0 ? '\nУсі перевірки пройдено.\n' : `\n${failures} перевірок не пройдено.\n`);
process.exit(failures === 0 ? 0 : 1);
