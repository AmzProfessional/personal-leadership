/**
 * Parser + validator for test definitions.
 *
 * Accepts either Markdown (the human-friendly format documented in
 * assets/questions.example.md) or JSON already in canonical shape, and returns
 * one normalized object. Everything downstream — discovery, the browser runner,
 * the dry-run report — consumes only this canonical shape, so the browser code
 * never has to care which format the user wrote.
 */

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'так', 'да']);
const SINGLE_WORDS = new Set(['single', 'one', 'radio', 'одна', 'одиночний', 'один']);
const MULTI_WORDS = new Set(['multiple', 'multi', 'many', 'checkbox', 'багато', 'множинний', 'декілька']);

/** Frontmatter keys are accepted in Ukrainian or English, snake or camel case. */
const META_ALIASES = {
  title: 'title',
  name: 'title',
  назва: 'title',
  'назва тесту': 'title',
  description: 'description',
  опис: 'description',
  'опис тесту': 'description',
  category: 'category',
  категорія: 'category',
  категория: 'category',
  department: 'departments',
  departments: 'departments',
  департамент: 'departments',
  департаменти: 'departments',
  'passing score': 'passingScore',
  passing_score: 'passingScore',
  passingscore: 'passingScore',
  'прохідний бал': 'passingScore',
  прохіднийбал: 'passingScore',
  'time limit': 'timeLimit',
  time_limit: 'timeLimit',
  timelimit: 'timeLimit',
  time: 'timeLimit',
  час: 'timeLimit',
  'minutes per question': 'minutesPerQuestion',
  minutes_per_question: 'minutesPerQuestion',
  minutesperquestion: 'minutesPerQuestion',
};

export class ParseError extends Error {}

function normKey(raw) {
  const k = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return META_ALIASES[k] ?? META_ALIASES[k.replace(/\s+/g, '')] ?? null;
}

function splitList(value) {
  const trimmed = value.trim().replace(/^\[|\]$/g, '');
  return trimmed
    .split(/[,;|]/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function normalizeType(raw, correctCount) {
  if (raw) {
    const v = String(raw).trim().toLowerCase();
    if (SINGLE_WORDS.has(v)) return 'single';
    if (MULTI_WORDS.has(v)) return 'multiple';
    throw new ParseError(`Невідомий тип питання: "${raw}" (очікується single або multiple)`);
  }
  // No explicit type: the number of marked answers is an unambiguous signal.
  return correctCount > 1 ? 'multiple' : 'single';
}

function parseFrontmatter(text) {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = normKey(line.slice(0, sep));
    if (!key) continue;
    const value = line.slice(sep + 1).trim();
    meta[key] = key === 'departments' ? splitList(value) : value;
  }
  return { meta, body: text.slice(match[0].length) };
}

/** `## 3) Текст питання` -> `Текст питання`; a bare `## Текст` is left alone. */
function stripHeadingNumber(text) {
  return text.replace(/^\s*\d+\s*[.)\]]\s+/, '').trim();
}

function parseMarkdown(text) {
  const { meta, body } = parseFrontmatter(text);
  const lines = body.split(/\r?\n/);

  const questions = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    current.text = current.textLines.join('\n').trim();
    current.explanation = current.explanationLines.join('\n').trim() || null;
    delete current.textLines;
    delete current.explanationLines;
    questions.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^\s{0,3}#{2,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      current = {
        line: i + 1,
        textLines: [stripHeadingNumber(heading[1])],
        explanationLines: [],
        options: [],
        rawType: null,
      };
      continue;
    }
    if (!current) continue; // preamble prose before the first question is ignored

    const option = /^\s*[-*+]\s*\[([ xX✓✔])\]\s*(.*)$/.exec(line);
    if (option) {
      current.options.push({
        text: option[2].trim(),
        correct: option[1].trim() !== '',
        line: i + 1,
      });
      continue;
    }

    const explanation = /^\s*>\s?(.*)$/.exec(line);
    if (explanation) {
      // "> Пояснення: ..." — drop the label, keep the prose.
      current.explanationLines.push(
        explanation[1].replace(/^\s*(пояснення|explanation)\s*[:—-]\s*/i, ''),
      );
      continue;
    }

    const typeLine = /^\s*(type|тип)\s*[:=]\s*(.+)$/i.exec(line);
    if (typeLine && current.options.length === 0) {
      current.rawType = typeLine[2].trim();
      continue;
    }

    // Anything else before the first option continues the question text, so a
    // long question can wrap across several lines without extra syntax.
    if (line.trim() && current.options.length === 0) current.textLines.push(line.trim());
  }
  flush();

  return { meta, questions };
}

function fromJson(data) {
  if (!data || typeof data !== 'object') throw new ParseError('JSON має бути обʼєктом');
  const meta = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'questions') continue;
    const key = normKey(k) ?? k;
    meta[key] = v;
  }
  const questions = (data.questions ?? []).map((q, idx) => ({
    line: idx + 1,
    textLines: [String(q.text ?? q.question ?? '')],
    explanationLines: q.explanation ? [String(q.explanation)] : [],
    rawType: q.type ?? null,
    options: (q.options ?? q.answers ?? []).map((o, oi) =>
      typeof o === 'string'
        ? { text: o, correct: false, line: oi + 1 }
        : { text: String(o.text ?? o.answer ?? ''), correct: Boolean(o.correct ?? o.isCorrect), line: oi + 1 },
    ),
  }));
  for (const q of questions) {
    q.text = q.textLines.join('\n').trim();
    q.explanation = q.explanationLines.join('\n').trim() || null;
    delete q.textLines;
    delete q.explanationLines;
  }
  return { meta, questions };
}

function coerceNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(String(value).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {string} raw    file contents
 * @param {string} format 'md' | 'json' | 'auto'
 */
export function parseTest(raw, format = 'auto') {
  const looksJson = raw.trim().startsWith('{');
  const useJson = format === 'json' || (format === 'auto' && looksJson);
  const { meta, questions } = useJson ? fromJson(JSON.parse(raw)) : parseMarkdown(raw);

  const errors = [];
  const warnings = [];

  if (!meta.title) errors.push('Не вказано назву тесту (title / "Назва тесту") у frontmatter.');
  if (questions.length === 0) errors.push('Не знайдено жодного питання (питання починаються з "## ").');

  const seen = new Map();
  const normalized = questions.map((q, idx) => {
    const where = `Питання #${idx + 1}${q.text ? ` ("${q.text.slice(0, 48)}")` : ''}`;
    if (!q.text) errors.push(`${where}: порожній текст питання (рядок ${q.line}).`);
    if (q.options.length < 2) errors.push(`${where}: потрібно щонайменше 2 варіанти відповіді, знайдено ${q.options.length}.`);

    const blank = q.options.filter((o) => !o.text);
    if (blank.length) errors.push(`${where}: є порожні варіанти відповіді (рядок ${blank[0].line}).`);

    const dupes = q.options.map((o) => o.text.toLowerCase()).filter((t, i, a) => a.indexOf(t) !== i);
    if (dupes.length) errors.push(`${where}: дубльований варіант відповіді "${dupes[0]}".`);

    const correct = q.options.filter((o) => o.correct);
    if (correct.length === 0) {
      errors.push(`${where}: не позначено жодної правильної відповіді (використайте "- [x] ...").`);
    }

    let type = 'single';
    try {
      type = normalizeType(q.rawType, correct.length);
    } catch (e) {
      errors.push(`${where}: ${e.message}`);
    }
    if (type === 'single' && correct.length > 1) {
      errors.push(`${where}: тип single, але позначено ${correct.length} правильних відповідей.`);
    }
    if (type === 'multiple' && correct.length === 1) {
      warnings.push(`${where}: тип multiple, але позначено лише одну правильну відповідь.`);
    }
    if (!q.explanation) warnings.push(`${where}: немає пояснення (показується після відповіді).`);

    const key = q.text.toLowerCase().trim();
    if (seen.has(key)) warnings.push(`${where}: текст дублює питання #${seen.get(key) + 1}.`);
    else seen.set(key, idx);

    return {
      text: q.text,
      type,
      explanation: q.explanation,
      options: q.options.map(({ text, correct }) => ({ text, correct })),
    };
  });

  const minutesPerQuestion = coerceNumber(meta.minutesPerQuestion, 1);
  const rawTime = meta.timeLimit;
  const timeLimit =
    rawTime === undefined || rawTime === null || rawTime === '' || /^auto$/i.test(String(rawTime))
      ? Math.max(1, Math.round(normalized.length * minutesPerQuestion))
      : coerceNumber(rawTime, normalized.length);

  const test = {
    title: meta.title ? String(meta.title) : '',
    description: meta.description ? String(meta.description) : '',
    category: meta.category ? String(meta.category) : null,
    departments: Array.isArray(meta.departments)
      ? meta.departments
      : meta.departments
        ? splitList(String(meta.departments))
        : [],
    passingScore: coerceNumber(meta.passingScore, 80),
    timeLimit,
    timeLimitWasAuto: rawTime === undefined || rawTime === null || rawTime === '' || /^auto$/i.test(String(rawTime)),
    minutesPerQuestion,
    questions: normalized,
  };

  return { test, errors, warnings };
}

export function formatReport({ test, errors, warnings }) {
  const lines = [];
  lines.push(`Назва:        ${test.title || '(відсутня)'}`);
  if (test.description) lines.push(`Опис:         ${test.description}`);
  lines.push(`Категорія:    ${test.category ?? '(не вказано)'}`);
  lines.push(`Департаменти: ${test.departments.length ? test.departments.join(', ') : '(не вказано)'}`);
  lines.push(`Прохідний бал:${String(test.passingScore).padStart(4)} %`);
  lines.push(
    `Час:          ${test.timeLimit} хв${test.timeLimitWasAuto ? ` (авто: ${test.questions.length} × ${test.minutesPerQuestion} хв)` : ''}`,
  );
  lines.push(`Питань:       ${test.questions.length}`);
  const single = test.questions.filter((q) => q.type === 'single').length;
  lines.push(`  одна відповідь: ${single} | багато відповідей: ${test.questions.length - single}`);
  if (warnings.length) {
    lines.push('', 'Попередження:');
    for (const w of warnings) lines.push(`  ! ${w}`);
  }
  if (errors.length) {
    lines.push('', 'Помилки:');
    for (const e of errors) lines.push(`  x ${e}`);
  }
  return lines.join('\n');
}
