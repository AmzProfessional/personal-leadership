/**
 * Selector resolution for an LMS whose exact DOM we do not control.
 *
 * The strategy chain matters more than any single selector: LMS front-ends get
 * restyled, class names are hashed, and Angular/Vue wrappers hide the real
 * <input> several levels below its visible label. So each field is described as
 * a *spec* (a bag of hints), and we try increasingly fuzzy strategies until one
 * matches. Every resolution reports which strategy won, which is what makes
 * `discover.mjs` output actionable — you can see whether a field was found the
 * robust way (test id / label) or the fragile way (positional fallback).
 */

/**
 * What counts as "a form control". Custom dropdown widgets are included
 * deliberately: LMS UIs almost never use a real <select>, and a category or
 * department picker rendered as a <button role="combobox"> is still the control
 * that belongs to its label.
 */
const CONTROL_SELECTOR = [
  'input:not([type=hidden]):not([type=submit]):not([type=button])',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '.ql-editor',
  '.ProseMirror',
  '[role="combobox"]',
  '[role="listbox"]',
  '[aria-haspopup="listbox"]',
  '.dropdown-toggle',
  '.ng-select',
  '.select2-selection',
].join(', ');

/**
 * A container holding more controls than this is a page section, not a field
 * wrapper. Without this cap the upward walk from a label with no nearby input
 * happily returns the first input of the whole form — which silently types the
 * category into the title field.
 */
const MAX_CONTROLS_PER_FIELD_CONTAINER = 3;

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Loose text match: case-insensitive, whitespace-collapsed, ignores trailing "*" and ":". */
export function textMatches(haystack, needle) {
  const clean = (s) =>
    String(s)
      .replace(/\s+/g, ' ')
      .replace(/[*:：]/g, '')
      .trim()
      .toLowerCase();
  const h = clean(haystack);
  const n = clean(needle);
  return n.length > 0 && (h === n || h.startsWith(n) || h.includes(n));
}

/**
 * Browser-side search: find the form control that visually belongs to a label.
 *
 * Tags the winner with a data attribute so the Node side can build a normal
 * locator for it (element handles do not survive re-renders; an attribute does,
 * at least long enough to act on it).
 */
async function anchoredControl(scope, texts, { tag, index = 0, controlSelector = CONTROL_SELECTOR, maxControls = MAX_CONTROLS_PER_FIELD_CONTAINER }) {
  const found = await scope.evaluate(
    ({ texts, tag, index, controlSelector, maxControls }) => {
      const clean = (s) =>
        String(s || '')
          .replace(/\s+/g, ' ')
          .replace(/[*:：]/g, '')
          .trim()
          .toLowerCase();
      const wanted = texts.map(clean).filter(Boolean);
      const root = document;

      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };

      // Own text only — otherwise a wrapper <div> "matches" everything inside it.
      const ownText = (el) =>
        Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join(' ');

      const candidates = [];
      for (const el of root.querySelectorAll('label, legend, span, div, p, h1, h2, h3, h4, h5, h6, th, td, b, strong')) {
        const t = clean(ownText(el));
        if (!t) continue;
        if (wanted.some((w) => t === w || t.startsWith(w) || t.includes(w))) candidates.push(el);
      }
      // Prefer the tightest label element (fewest descendants) for a given text.
      candidates.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);

      const controlsFor = (label) => {
        const out = [];
        // 1. Explicit association is the most reliable link there is.
        const forId = label.getAttribute && label.getAttribute('for');
        if (forId) {
          const target = document.getElementById(forId);
          if (target) out.push(target);
        }
        // 2. Control nested inside the label.
        out.push(...label.querySelectorAll(controlSelector));
        // 3. Walk up a few levels; the first container that holds a control is
        //    almost always the form-group wrapper for this label. Stop as soon
        //    as a container looks like a whole form section rather than one
        //    field, otherwise a label with no nearby input silently binds to
        //    some unrelated field further up the page.
        let node = label;
        for (let depth = 0; depth < 5 && node; depth++) {
          node = node.parentElement;
          if (!node) break;
          const hits = Array.from(node.querySelectorAll(controlSelector));
          if (hits.length > maxControls) break;
          if (hits.length) {
            out.push(...hits);
            break;
          }
        }
        // 4. Following siblings, for layouts that put the label above the field.
        let sib = label.nextElementSibling;
        for (let i = 0; i < 3 && sib; i++, sib = sib.nextElementSibling) {
          if (sib.matches && sib.matches(controlSelector)) out.push(sib);
          out.push(...sib.querySelectorAll(controlSelector));
        }
        return out;
      };

      const seen = new Set();
      const controls = [];
      for (const label of candidates) {
        for (const c of controlsFor(label)) {
          if (!c || seen.has(c) || !isVisible(c)) continue;
          seen.add(c);
          controls.push(c);
        }
      }
      const target = controls[index];
      if (!target) return null;
      target.setAttribute(tag, '1');
      return {
        tagName: target.tagName.toLowerCase(),
        type: target.getAttribute('type'),
        editable: target.isContentEditable === true,
      };
    },
    { texts, tag, index, controlSelector, maxControls },
  );
  return found;
}

/**
 * Resolve a field spec to a Playwright locator.
 *
 * Spec fields (all optional, tried in this order):
 *   testId      string | string[]  - data-testid / data-test / data-qa value
 *   css         string | string[]  - explicit CSS, wins over everything if set
 *   label       string | string[]  - visible label text
 *   placeholder string | string[]
 *   role        string             - ARIA role, paired with `name`
 *   name        string | string[]  - accessible name for the role lookup
 *   nth         number             - pick the nth match (default 0)
 *
 * @returns {{locator: import('playwright').Locator, strategy: string} | null}
 */
export async function resolve(page, spec, { scope = null, timeout = 1200 } = {}) {
  if (!spec) return null;
  const root = scope ?? page;
  const nth = spec.nth ?? 0;

  const tryLocator = async (locator, strategy) => {
    try {
      const count = await locator.count();
      if (count <= nth) return null;
      const target = locator.nth(nth);
      await target.waitFor({ state: 'attached', timeout });
      return { locator: target, strategy };
    } catch {
      return null;
    }
  };

  for (const css of asArray(spec.css)) {
    const hit = await tryLocator(root.locator(css), `css:${css}`);
    if (hit) return hit;
  }

  for (const id of asArray(spec.testId)) {
    const hit = await tryLocator(
      root.locator(`[data-testid="${id}"], [data-test="${id}"], [data-qa="${id}"]`),
      `testId:${id}`,
    );
    if (hit) return hit;
  }

  for (const label of asArray(spec.label)) {
    const hit = await tryLocator(root.getByLabel(label, { exact: false }), `label:${label}`);
    if (hit) return hit;
  }

  for (const ph of asArray(spec.placeholder)) {
    const hit = await tryLocator(root.getByPlaceholder(ph, { exact: false }), `placeholder:${ph}`);
    if (hit) return hit;
  }

  if (spec.role) {
    const names = asArray(spec.name);
    if (names.length === 0) {
      const hit = await tryLocator(root.getByRole(spec.role), `role:${spec.role}`);
      if (hit) return hit;
    }
    for (const name of names) {
      const hit = await tryLocator(
        root.getByRole(spec.role, { name: new RegExp(escapeRe(name), 'i') }),
        `role:${spec.role}[${name}]`,
      );
      if (hit) return hit;
    }
  }

  // Last resort: anchor on visible text and hunt for the nearest control.
  const anchors = [...asArray(spec.label), ...asArray(spec.name), ...asArray(spec.anchor)];
  if (anchors.length) {
    const tag = `data-lms-auto-${Math.random().toString(36).slice(2, 8)}`;
    const info = await anchoredControl(page, anchors, {
      tag,
      index: nth,
      controlSelector: spec.controlSelector ?? CONTROL_SELECTOR,
      maxControls: spec.maxControls ?? MAX_CONTROLS_PER_FIELD_CONTAINER,
    });
    if (info) {
      return { locator: page.locator(`[${tag}]`).first(), strategy: `anchored:${anchors[0]} -> ${info.tagName}` };
    }
  }

  return null;
}

export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve or throw with a message that says what to fix in selectors.json. */
export async function mustResolve(page, spec, fieldName, opts) {
  const hit = await resolve(page, spec, opts);
  if (!hit) {
    throw new Error(
      `Не вдалося знайти поле "${fieldName}" на сторінці.\n` +
        `  Підказки, які пробували: ${JSON.stringify(spec)}\n` +
        `  Запустіть "node scripts/discover.mjs" і додайте точний селектор у config/selectors.json -> fields.${fieldName}.css`,
    );
  }
  return hit;
}

/**
 * Type into whatever kind of control this turned out to be.
 * Rich-text editors (Quill/ProseMirror) do not respond to fill(), so
 * contenteditable gets the keyboard path instead.
 */
export async function setText(locator, value) {
  if (value === undefined || value === null) return;
  const editable = await locator.evaluate((el) => el.isContentEditable === true).catch(() => false);
  if (editable) {
    await locator.click();
    await locator.evaluate((el) => {
      el.innerHTML = '';
    });
    await locator.type(String(value), { delay: 4 });
    return;
  }
  await locator.fill(String(value));
}

/**
 * Choose a value in either a native <select> or a custom dropdown widget.
 * Custom dropdowns are the common case in modern LMS UIs: click to open, then
 * click the option wherever it got portalled to in the DOM.
 */
export async function chooseOption(page, control, value, { timeout = 4000 } = {}) {
  const tagName = await control.evaluate((el) => el.tagName.toLowerCase());
  if (tagName === 'select') {
    try {
      await control.selectOption({ label: String(value) });
      return 'native:label';
    } catch {
      await control.selectOption({ value: String(value) });
      return 'native:value';
    }
  }

  await control.click();
  const pattern = new RegExp(escapeRe(value), 'i');

  // Menus animate open, and an option that exists in the DOM but is still
  // hidden will fail the click. Filtering to :visible and waiting for it is
  // what makes this reliable across widget libraries.
  const visibleOption = (locator) => locator.locator('visible=true');

  const byRole = visibleOption(page.getByRole('option', { name: pattern }));
  if (await byRole.count().catch(() => 0)) {
    await byRole.first().click({ timeout });
    return 'role:option';
  }

  const menuItems = page
    .locator('li, [role="option"], .dropdown-item, .select-option, .mat-option, .ant-select-item, .v-list-item, .option')
    .filter({ hasText: pattern });
  const fallback = visibleOption(menuItems);
  if (await fallback.count().catch(() => 0)) {
    await fallback.first().click({ timeout });
    return 'list:item';
  }
  // Present but hidden: the menu is probably still opening.
  if (await menuItems.count().catch(() => 0)) {
    await menuItems.first().waitFor({ state: 'visible', timeout }).catch(() => {});
    if (await fallback.count().catch(() => 0)) {
      await fallback.first().click({ timeout });
      return 'list:item(delayed)';
    }
  }

  // Some widgets are combobox-with-search: type, then take the first hit.
  await control.type(String(value), { delay: 15 }).catch(() => {});
  const afterType = page.locator('li, [role="option"], .dropdown-item, .mat-option, .ant-select-item').filter({ hasText: pattern });
  if (await afterType.count()) {
    await afterType.first().click({ timeout });
    return 'search:option';
  }

  throw new Error(`Не вдалося вибрати "${value}" у випадаючому списку.`);
}

/** Tick a checkbox/radio without unticking one that is already correct. */
export async function ensureChecked(locator) {
  const isInput = await locator.evaluate((el) => el.tagName.toLowerCase() === 'input').catch(() => false);
  if (isInput) {
    if (!(await locator.isChecked())) await locator.check({ force: true });
    return;
  }
  // Custom toggle: infer state from aria/class, click only if it is off.
  const on = await locator
    .evaluate((el) => {
      const aria = el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected');
      if (aria !== null) return aria === 'true';
      return /(^|\s)(checked|selected|active|is-checked)(\s|$)/.test(el.className || '');
    })
    .catch(() => false);
  if (!on) await locator.click({ force: true });
}

export { CONTROL_SELECTOR };
