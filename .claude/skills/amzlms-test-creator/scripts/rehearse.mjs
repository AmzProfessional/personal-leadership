/**
 * Репетиція: прогнати реальний файл питань через повну браузерну
 * автоматизацію, але проти локального макета LMS, а не проти продакшну.
 *
 *   node scripts/rehearse.mjs мій-тест.txt
 *
 * Навіщо це окремо від `--dry-run`: dry-run перевіряє тільки розбір файлу.
 * Репетиція проходить увесь шлях — заповнення форми, вибір у дропдаунах,
 * додавання рядків відповідей, перемикання типу питання, збереження — і
 * звіряє те, що «LMS» реально отримала, з тим, що було у файлі.
 *
 * Це ловить інший клас помилок: коли файл розібрано правильно, але
 * автоматизація кладе дані не туди. Перед першою заливкою великого тесту в
 * продакшн це найдешевша перевірка, яка існує.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTest, formatReport } from './parse-questions.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = process.argv[2];

if (!inputPath) {
  console.error('Використання: node scripts/rehearse.mjs <файл із питаннями>');
  process.exit(1);
}

const raw = readFileSync(inputPath, 'utf8');
const parsed = parseTest(raw, path.extname(inputPath).toLowerCase() === '.json' ? 'json' : 'md');
if (parsed.errors.length) {
  console.log(formatReport(parsed));
  console.error('\nФайл містить помилки — репетиція не запускалась.');
  process.exit(1);
}

const html = readFileSync(path.join(SKILL, 'tests', 'mock-lms', 'index.html'), 'utf8');
let received = null;

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

console.log(`Репетиція: ${path.basename(inputPath)} -> локальний макет LMS`);
console.log(`Питань у файлі: ${parsed.test.questions.length}\n`);

const profile = path.join(mkdtempSync(path.join(tmpdir(), 'lms-rehearse-')), 'profile');
const run = await new Promise((done) => {
  const child = spawn(
    'node',
    [path.join(SKILL, 'scripts', 'create-test.mjs'), path.resolve(inputPath), '--base-url', mockUrl, '--headless', '--slow-mo', '0'],
    { env: { ...process.env, AMZLMS_PROFILE: profile } },
  );
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  child.on('close', (status) => done({ status, out }));
});
server.close();

if (!received) {
  console.error('Макет не отримав даних. Вивід автоматизації:\n');
  console.error(run.out.slice(-2000));
  process.exit(1);
}

// Звіряємо те, що «LMS» отримала, з тим, що було у файлі.
const problems = [];
const want = parsed.test;
const got = received.test ?? {};

const compare = (name, expected, actual) => {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(16)} ${ok ? String(expected) : `очікували ${JSON.stringify(expected)}, отримали ${JSON.stringify(actual)}`}`);
  if (!ok) problems.push(name);
};

console.log('Метадані тесту:');
compare('назва', want.title, got.title);
compare('опис', want.description, got.description);
compare('департаменти', want.departments, got.departments);
compare('прохідний бал', want.passingScore, got.passingScore);
compare('час, хв', want.timeLimit, got.timeLimit);
if (want.category) compare('категорія', want.category, got.category);

console.log('\nПитання:');
const gotQs = received.questions ?? [];
if (gotQs.length !== want.questions.length) {
  problems.push('кількість питань');
  console.log(`  ✗ додано ${gotQs.length} із ${want.questions.length}`);
}

want.questions.forEach((q, i) => {
  const g = gotQs[i];
  const issues = [];
  if (!g) issues.push('питання не додано');
  else {
    if (g.text !== q.text) issues.push('текст питання');
    if (g.type !== q.type) issues.push(`тип (${g.type} замість ${q.type})`);
    if ((g.options ?? []).length !== q.options.length) issues.push(`варіантів ${(g.options ?? []).length} замість ${q.options.length}`);
    else {
      q.options.forEach((o, oi) => {
        if (g.options[oi].text !== o.text) issues.push(`текст варіанта ${oi + 1}`);
        if (g.options[oi].correct !== o.correct) issues.push(`позначка правильної у варіанті ${oi + 1}`);
      });
    }
    if ((g.explanation || null) !== (q.explanation || null)) issues.push('пояснення');
    if (JSON.stringify(g).includes('✅')) issues.push('галочка ✅ потрапила в текст');
  }

  const correct = q.options.filter((o) => o.correct).length;
  const label = `${String(i + 1).padStart(2)}. ${q.type.padEnd(8)} ${q.options.length} вар. / ${correct} прав.  ${q.text.slice(0, 44)}${q.text.length > 44 ? '…' : ''}`;
  console.log(`  ${issues.length ? '✗' : '✓'} ${label}${issues.length ? `\n       -> ${issues.join(', ')}` : ''}`);
  if (issues.length) problems.push(`питання ${i + 1}`);
});

/** 1 питання / 2-4 питання / 5-20 питань — інакше звіт читається неохайно. */
const questionWord = (n) => {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return 'питань';
  if (ones === 1) return 'питання';
  if (ones >= 2 && ones <= 4) return 'питання';
  return 'питань';
};

console.log(
  problems.length === 0
    ? `\nРепетиція пройшла: усі ${want.questions.length} ${questionWord(want.questions.length)} лягли в макет LMS без розбіжностей.\nУ продакшн нічого не записувалось.`
    : `\nРозбіжностей: ${problems.length} (${problems.slice(0, 5).join(', ')}${problems.length > 5 ? '…' : ''}).`,
);
process.exit(problems.length === 0 ? 0 : 1);
