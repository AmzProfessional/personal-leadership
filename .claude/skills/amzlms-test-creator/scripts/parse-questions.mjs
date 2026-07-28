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

function setMeta(meta, key, value) {
  meta[key] = key === 'departments' ? splitList(value) : value;
}

function parseFencedFrontmatter(text) {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return null;

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = normKey(line.slice(0, sep));
    if (!key) continue;
    setMeta(meta, key, line.slice(sep + 1).trim());
  }
  return { meta, body: text.slice(match[0].length) };
}

/**
 * Metadata written as plain `Назва тесту: ...` lines with no `---` fences.
 *
 * This is how the header actually arrives when someone pastes a prepared test,
 * so requiring fences would just move the conversion work onto the person. We
 * read leading `key: value` lines until the first question or answer appears;
 * a wrapped value (a long Опис spilling onto the next line) continues the
 * previous key rather than being dropped.
 */
function parseLooseFrontmatter(lines) {
  const meta = {};
  let lastKey = null;
  let i = 0;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (matchQuestionStart(line) !== null) break;
    if (matchOption(line)) break;

    const sep = line.indexOf(':');
    const key = sep > 0 ? normKey(line.slice(0, sep)) : null;
    if (key) {
      setMeta(meta, key, line.slice(sep + 1).trim());
      lastKey = key;
      continue;
    }
    if (lastKey && typeof meta[lastKey] === 'string') {
      meta[lastKey] = `${meta[lastKey]} ${line.trim()}`.trim();
      continue;
    }
    break; // leading prose that is not metadata — leave it to the question loop
  }

  return { meta, startIndex: i };
}

/** `## 3) Текст питання` -> `Текст питання`; a bare `## Текст` is left alone. */
function stripHeadingNumber(text) {
  return text.replace(/^\s*\d+\s*[.)\]]\s+/, '').trim();
}

/**
 * Does this line open a new question? Two spellings are accepted: a Markdown
 * heading (`## Текст`) and the numbered form people actually type when writing
 * a test by hand (`Питання 7. Текст`).
 *
 * @returns {string|null} the question text, or null if this is not a question start
 */
function matchQuestionStart(line) {
  const heading = /^\s{0,3}#{2,6}\s+(.*)$/.exec(line);
  if (heading) return stripHeadingNumber(heading[1]);

  const numbered = /^\s*(?:\*\*)?\s*(?:питання|запитання|question)\s*№?\s*\d+\s*[.):\]]?\s*(?:\*\*)?\s*(.*)$/iu.exec(line);
  if (numbered) return numbered[1].replace(/^\*\*|\*\*$/g, '').trim();

  return null;
}

/**
 * A tick mark at the start of an answer means "this is the correct one". It is
 * a marker, not part of the answer, so it must be stripped — otherwise the ✅
 * ends up inside the option text shown to people taking the test.
 */
const CORRECT_MARK = /^(?:\*\*)?\s*(?:✅|❇️|✔️|✔|✓|☑️|☑|\+)\s*(?:\*\*)?\s*/u;

/**
 * @returns {{text: string, correct: boolean}|null}
 */
function matchOption(line) {
  const bullet = /^\s*[-*+•·]\s+(.*)$/u.exec(line);
  if (!bullet) return null;
  const body = bullet[1];

  const checkbox = /^\[([ xX✓✔])\]\s*(.*)$/.exec(body);
  if (checkbox) return { text: checkbox[2].trim(), correct: checkbox[1].trim() !== '' };

  if (CORRECT_MARK.test(body)) return { text: body.replace(CORRECT_MARK, '').trim(), correct: true };

  return { text: body.trim(), correct: false };
}

/** `Пояснення: ...`, `> Пояснення: ...` and `**Пояснення:**  ...` all count. */
const EXPLANATION_LABEL = /^\s*(?:>\s?)?(?:\*\*)?\s*(?:пояснення|поясненя|explanation|rationale)\s*(?:\*\*)?\s*[:：—-]\s*(.*)$/iu;

function parseMarkdown(text) {
  const fenced = parseFencedFrontmatter(text);
  const lines = (fenced ? fenced.body : text).split(/\r?\n/);
  const loose = fenced ? { meta: {}, startIndex: 0 } : parseLooseFrontmatter(lines);
  const meta = fenced ? fenced.meta : loose.meta;

  const questions = [];
  let current = null;
  // Which part of the question the unmarked lines belong to. Without this a
  // wrapped answer or a multi-line explanation would silently vanish.
  let section = 'text';

  const flush = () => {
    if (!current) return;
    current.text = current.textLines.join('\n').trim();
    current.explanation = current.explanationLines.join('\n').trim() || null;
    delete current.textLines;
    delete current.explanationLines;
    questions.push(current);
    current = null;
  };

  for (let i = loose.startIndex; i < lines.length; i++) {
    const line = lines[i];

    const questionText = matchQuestionStart(line);
    if (questionText !== null) {
      flush();
      section = 'text';
      current = {
        line: i + 1,
        textLines: questionText ? [questionText] : [],
        explanationLines: [],
        options: [],
        rawType: null,
      };
      continue;
    }
    if (!current) continue; // preamble prose before the first question is ignored

    const option = matchOption(line);
    if (option) {
      section = 'options';
      current.options.push({ ...option, line: i + 1 });
      continue;
    }

    const labelled = EXPLANATION_LABEL.exec(line);
    if (labelled) {
      section = 'explanation';
      current.explanationLines.push(labelled[1]);
      continue;
    }

    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) {
      section = 'explanation';
      current.explanationLines.push(quoted[1]);
      continue;
    }

    const typeLine = /^\s*(?:type|тип)\s*[:=]\s*(.+)$/i.exec(line);
    if (typeLine && current.options.length === 0) {
      current.rawType = typeLine[1].trim();
      continue;
    }

    if (!line.trim()) continue;

    // An unmarked line continues whatever came last: the question stem, a
    // wrapped answer, or the explanation.
    if (section === 'text') current.textLines.push(line.trim());
    else if (section === 'explanation') current.explanationLines.push(line.trim());
    else if (current.options.length) current.options.at(-1).text += ` ${line.trim()}`;
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

  // Per-question breakdown: this is where a mis-read answer marker shows up.
  // A question that should have one correct answer and shows 0 (or 4) is
  // visible here in a second, and only here — the totals above would hide it.
  if (test.questions.length) {
    lines.push('', '  №  тип       варіантів  правильних  питання');
    test.questions.forEach((q, i) => {
      const correct = q.options.filter((o) => o.correct).length;
      lines.push(
        `  ${String(i + 1).padStart(2)}  ${q.type.padEnd(9)} ${String(q.options.length).padStart(6)} ${String(correct).padStart(10)}    ${q.text.slice(0, 52)}${q.text.length > 52 ? '…' : ''}`,
      );
    });
  }
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
