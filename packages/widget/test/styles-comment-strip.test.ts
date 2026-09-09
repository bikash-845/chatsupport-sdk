// The stylesheet's CSS comments are stripped at build time, from BOTH build
// paths, and nothing else about the sheet changes.
//
// ── Why this needs a test at all ──────────────────────────────────────────
//
// `src/ui/styles.ts` keeps the whole sheet in one template literal, so its
// `/* … */` blocks are string DATA. No minifier removes them, and a regex
// that removes one byte too many ships a broken stylesheet to every customer
// of every host page at once — with no runtime error anywhere, because a
// browser's CSS parser discards what it cannot understand and keeps going.
// So the decisive assertion here is EQUIVALENCE, not size: the sheet that
// reaches the browser must be the sheet the source declares, minus comments.
//
// ── What this file can and cannot prove ───────────────────────────────────
//
// It compares STRINGS. It proves that the built stylesheet is byte-for-byte
// the source stylesheet with its comments removed, and that the artifacts
// carry no comment prose. It does NOT prove that a browser parses the
// stripped sheet into the same rules — no CSS engine runs here. That is a
// real-Chrome claim; `packages/widget/scripts/verify-appearance.mjs` is the
// harness that could make it, and this file does not stand in for it.
//
// ── The dist checks need a build ──────────────────────────────────────────
//
// Two tests read `dist/`. CI builds before it tests (`.github/workflows/ci.yml`
// runs `pnpm -r build` ahead of `pnpm test`, deliberately), and they are the
// only checks that can see BOTH shipped artifacts and therefore the only ones
// that catch the plugin being registered in one build path and forgotten in
// the other. Run `pnpm --filter @dhaam-ccrm/widget build` first; they say so
// by name if you have not.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { stripCssComments, stripCssCommentsPlugin } from '../build/strip-css-comments.mjs';
import { resolveConfig } from '../src/config.js';
import { STYLES } from '../src/ui/styles.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stylesSource = join(packageRoot, 'src', 'ui', 'styles.ts');

// ─────────────────────────────────────────────────────────────────────────
// Reference normalisation.
//
// The reference is produced by a DIFFERENT mechanism from the one under
// test, or the comparison would be circular. `STYLES` imported here is the
// runtime string with `${DARK_TOKENS}` already interpolated and every comment
// still in it, and the strip below is the CORRECT semantic for CSS comments
// once you are inside pure CSS text with no JavaScript around it: comments do
// not nest, so the first `*/` terminates — and a `/*` inside a STRING is not a
// comment opener at all, it is content the browser renders.
//
// That last clause is why this is no longer the one-line regex it was, and no
// longer the same normalisation `test/brand-band.test.ts` uses (that file
// still has the regex at its line 196, and can: it asks whether a rule is
// PRESENT, not whether two sheets are equal).
// `css.replace(/\/\*[\s\S]*?\*\//g, '')` has exactly the blind spot the
// transform had, so it called a stripped `content: "draft /* internal */
// note"` equal to the source and would have reported GREEN on a corrupted
// sheet. An oracle that cannot disagree with the implementation cannot
// falsify it.
// ─────────────────────────────────────────────────────────────────────────

/** The reference strip: CSS comments removed, CSS strings stepped over. */
function stripCssCommentsFromCss(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const end = endOfCssString(css, i, ch);
      out += css.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close === -1 ? css.length : close + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Every quoted string in a CSS text, delimiters included. Comments are skipped
 * first, or the apostrophe in a comment's prose would be read as opening one.
 */
function quotedStrings(css: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close === -1 ? css.length : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = endOfCssString(css, i, ch);
      found.push(css.slice(i, end));
      i = end;
      continue;
    }
    i += 1;
  }
  return found;
}

/** Whitespace runs are not significant in CSS; their PRESENCE is. */
const collapse = (css: string): string => css.replace(/\s+/g, ' ').trim();

// ─────────────────────────────────────────────────────────────────────────
// An at-rule-AWARE rule splitter.
//
// `test/brand-band.test.ts` documents that its splitter flattens at-rules —
// each rule inside an `@media` is emitted as though it were top level, with
// its condition discarded. Inheriting that here would be a hole exactly the
// size of a mangled `@media` block: a strip that deleted a media condition,
// or moved a rule out of one, would compare equal. This one keeps the
// enclosing at-rule preludes as a path, so `@media (…) { .a { … } }` and
// `.a { … }` are different entries.
// ─────────────────────────────────────────────────────────────────────────

interface FlatRule {
  /** Enclosing at-rule preludes, outermost first. */
  readonly at: readonly string[];
  readonly selector: string;
  readonly declarations: readonly string[];
}

function flattenCss(css: string): FlatRule[] {
  const rules: FlatRule[] = [];
  const path: string[] = [];
  let prelude = '';
  let i = 0;

  while (i < css.length) {
    const ch = css[i];

    if (ch === '"' || ch === "'") {
      const end = endOfCssString(css, i, ch);
      prelude += css.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '{') {
      const body = matchingBrace(css, i);
      const inner = css.slice(i + 1, body);
      const head = collapse(prelude);
      prelude = '';
      if (containsRule(inner)) {
        path.push(head);
        rules.push(...flattenCss(inner).map((rule) => ({ ...rule, at: [head, ...rule.at] })));
        path.pop();
      } else {
        rules.push({ at: [], selector: head, declarations: splitDeclarations(inner) });
      }
      i = body + 1;
      continue;
    }

    if (ch === '}') {
      // Unbalanced input. Nothing to attribute the tail to; stop rather than
      // silently attach it to the previous rule.
      prelude = '';
      i += 1;
      continue;
    }

    prelude += ch;
    i += 1;
  }

  return rules;
}

/** Does this block body contain a nested `selector { … }` rather than only declarations? */
function containsRule(body: string): boolean {
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '"' || ch === "'") {
      i = endOfCssString(body, i, ch) - 1;
      continue;
    }
    if (ch === '{') return true;
  }
  return false;
}

function matchingBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      i = endOfCssString(css, i, ch) - 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced braces from offset ${open}`);
}

function endOfCssString(css: string, start: number, quote: string): number {
  for (let i = start + 1; i < css.length; i += 1) {
    if (css[i] === '\\') {
      i += 1;
      continue;
    }
    if (css[i] === quote) return i + 1;
  }
  return css.length;
}

/** A declaration block's `prop: value` pairs, in order, parens and strings respected. */
function splitDeclarations(body: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '"' || ch === "'") {
      const end = endOfCssString(body, i, ch);
      current += body.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ';' && depth === 0) {
      parts.push(collapse(current));
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(collapse(current));
  return parts.filter((part) => part !== '');
}

// ─────────────────────────────────────────────────────────────────────────
// Building the stylesheet module the way the shipped builds do.
// ─────────────────────────────────────────────────────────────────────────

let scratch = '';
/** `src/ui/styles.ts`, built through the real plugin and evaluated. */
let stripped: { STYLES: string; themeCss: (config: never) => string };

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'dh-styles-strip-'));
  const outfile = join(scratch, 'styles.mjs');
  await build({
    entryPoints: [stylesSource],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: ['es2020'],
    plugins: [stripCssCommentsPlugin()],
    logLevel: 'silent',
  });
  stripped = (await import(pathToFileURL(outfile).href)) as typeof stripped;
});

afterAll(() => {
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

describe('the stripped stylesheet is the same stylesheet', () => {
  // The tight net. Any byte added, removed or moved outside a comment — in a
  // selector, in a declaration, inside a `url()`, inside an `@media`
  // condition, inside a CSS string — changes this comparison. Whitespace RUNS
  // are collapsed because their length is not significant in CSS; their
  // presence still is, and a lost space shows up here as `a b` vs `ab`.
  it('is byte-for-byte the source sheet minus its comments', () => {
    expect(collapse(stripped.STYLES)).toBe(collapse(stripCssCommentsFromCss(STYLES)));
  });

  // The readable half of the same claim, and the one that localises a
  // failure: same rules, in the same order, under the same at-rules, with the
  // same declarations in the same order.
  it('declares the same rules, in the same order, with the same declarations', () => {
    const before = flattenCss(stripCssCommentsFromCss(STYLES));
    const after = flattenCss(stripped.STYLES);

    expect(after.map((rule) => [...rule.at, rule.selector].join(' >> '))).toEqual(
      before.map((rule) => [...rule.at, rule.selector].join(' >> ')),
    );
    expect(after.map((rule) => rule.declarations)).toEqual(before.map((rule) => rule.declarations));
  });

  // The splitter is only worth trusting if it actually descends into the
  // at-rules this sheet has. If this ever reads 0 the comparison above has
  // gone blind to exactly the case brand-band.test.ts warns about.
  it('compares rules nested inside at-rules rather than flattening them', () => {
    const nested = flattenCss(stripCssCommentsFromCss(STYLES)).filter((rule) => rule.at.length > 0);
    expect(nested.length).toBeGreaterThan(0);
    expect(nested.some((rule) => rule.at.some((at) => at.startsWith('@media')))).toBe(true);
  });

  it('leaves no CSS comment in the stripped sheet', () => {
    expect(stripped.STYLES).not.toContain('/*');
  });

  it('actually removed the sheet the source carries', () => {
    expect(STYLES).toContain('/*');
    expect(stripped.STYLES.length).toBeLessThan(STYLES.length);
  });
});

describe('the ${…} interpolations survive', () => {
  // `STYLES` interpolates `${DARK_TOKENS}` twice — once for the OS preference
  // and once for an explicit `theme: 'dark'`. Swallowing either would leave
  // half the merchants on a half-dark widget.
  it('keeps both copies of the dark palette', () => {
    const occurrences = stripped.STYLES.split('--dh-mesh-bg: #1c1a24').length - 1;
    expect(occurrences).toBe(2);
    expect(STYLES.split('--dh-mesh-bg: #1c1a24').length - 1).toBe(2);
  });

  // Real config values through the real resolver, into the stripped module's
  // own `themeCss` — the other interpolation site in this file, and the one
  // that carries the merchant's brand.
  it('still themes a real config from the stripped module', () => {
    const config = resolveConfig({
      auth: {
        publishableKey: 'dhp_' + 'test_' + '0123456789abcdefghijklmn',
        tokenEndpoint: '/api/chat-token',
      },
      identity: { userId: 'cus_1' },
      apiUrl: 'https://chat.example.com',
      wsUrl: 'wss://chat.example.com',
      accent: '#ff5722',
      cornerRadius: 18,
    });
    const css = stripped.themeCss(config as never);

    expect(css).toContain('--dh-accent: #ff5722');
    expect(css).toContain('--dh-radius: 18px');
    expect(css).not.toContain('${');
  });
});

describe('the transform, on the shapes that break naive strippers', () => {
  const strip = (source: string): string => stripCssComments(source).code;

  it('ends a comment at the first */, CSS-style, and leaves the rest as data', () => {
    expect(strip('const A = `a { /* x */ y */ }`;')).toBe('const A = `a { y */ }`;');
  });

  it('does not nest: an inner /* is part of the comment', () => {
    expect(strip('const A = `a { /* x /* y */ z }`;')).toBe('const A = `a { z }`;');
  });

  // A protocol-relative or absolute URL contains `//`. `//` is NEVER a comment
  // inside template text.
  it('leaves // alone, in url() and everywhere else', () => {
    const source = 'const A = `a { background: url(https://x.example/y.png); }`;';
    expect(strip(source)).toBe(source);
    expect(strip('const A = `a { background: url(//x.example/y.png); }`;')).toBe(
      'const A = `a { background: url(//x.example/y.png); }`;',
    );
  });

  it('refuses an unterminated comment rather than guessing where it ends', () => {
    expect(() => strip('const A = `a { /* x }`;')).toThrow(/runs past the end of its template literal/);
    expect(() => strip('const A = `a { /* x ')).toThrow(/unterminated CSS comment/);
  });

  it('refuses to delete a comment that runs into an interpolation', () => {
    expect(() => strip('const A = `a { /* x ${y} */ }`;')).toThrow(/interpolation/);
  });

  // The one shape it declines to touch. `.a/* c */.b` is the COMPOUND
  // selector `.a.b`; deleting the comment joins two tokens and spacing it
  // makes it a descendant selector. Both are different rules, so it stays.
  it('leaves a comment with no whitespace on either side exactly where it is', () => {
    const source = 'const A = `.a/* c */.b { color: red; }`;';
    const result = stripCssComments(source);
    expect(result.code).toBe(source);
    expect(result.kept).toBe(1);
    expect(result.removed).toBe(0);
  });

  it('collapses only the whitespace the comment leaves behind', () => {
    expect(strip('const A = `\n  /* c */\n  color: red;\n`;')).toBe('const A = `\n  color: red;\n`;');
    expect(strip('const A = `a /* c */ b { color: red; }`;')).toBe('const A = `a b { color: red; }`;');
  });

  // The asymmetric case, and the reason the collapse is not "eat the
  // whitespace on both sides". With whitespace only AFTER the comment, that
  // run is the only separator in play: taking it too would turn the
  // descendant selector `.a .b` into the compound selector `.a.b`, which
  // matches a different element entirely.
  it('keeps the trailing space when it is the only separator there is', () => {
    expect(strip('const A = `.a/* c */ .b { color: red; }`;')).toBe('const A = `.a .b { color: red; }`;');
    expect(strip('const A = `.a /* c */.b { color: red; }`;')).toBe('const A = `.a .b { color: red; }`;');
  });

  it('leaves JavaScript comments to the minifier', () => {
    const source = '/** doc */\n// line\nconst A = 1;\n';
    expect(strip(source)).toBe(source);
  });

  // Three shapes that desynchronise a scanner without comment/regex
  // awareness. They are kept as regressions for what a stylesheet module
  // GROWS, not as a description of what the file has: of the three, only the
  // regex containing quotes is a break `src/ui/styles.ts` demonstrates today;
  // the regex containing `*/` is present as characters that break nothing
  // measured, and the unbalanced backtick is not present at all.
  // `build/strip-css-comments.mjs`'s header carries the measurements.
  it('is not desynchronised by a regex literal containing */', () => {
    const source = 'const r = /[;{}()<>\\\\]|\\/\\*/;\nconst A = `a { /* c */ color: red; }`;';
    expect(strip(source)).toBe('const r = /[;{}()<>\\\\]|\\/\\*/;\nconst A = `a { color: red; }`;');
  });

  it('is not desynchronised by a regex literal containing quotes', () => {
    const source = 'const r = /["\'()\\\;\\s]/;\nconst A = `a { /* c */ color: red; }`;';
    expect(strip(source)).toBe('const r = /["\'()\\\;\\s]/;\nconst A = `a { color: red; }`;');
  });

  it('is not desynchronised by an unbalanced backtick inside a JSDoc block', () => {
    const source = '/** `--a: ("` breaks out */\nconst A = `a { /* c */ color: red; }`;';
    expect(strip(source)).toBe('/** `--a: ("` breaks out */\nconst A = `a { color: red; }`;');
  });

  it('never touches a quoted string, even one holding a comment', () => {
    const source = "const s = '/* not a comment */';\n";
    expect(strip(source)).toBe(source);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CSS strings.
//
// `/*` inside a CSS string is not a comment opener, it is content: the
// browser renders `content: "draft /* internal */ note"` with those
// characters in it. A transform that deletes them changes what the page
// SAYS, silently, which is the one direction this build step exists to
// promise it cannot go.
// ─────────────────────────────────────────────────────────────────────────

describe('a CSS string is data, so a /* inside one is not a comment', () => {
  const strip = (source: string): string => stripCssComments(source).code;

  /** Untouched, and for the right reason: there was no comment to see. */
  const untouched = (source: string): void => {
    const result = stripCssComments(source);
    expect(result.code).toBe(source);
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(0);
  };

  it('leaves a /* … */ inside a double-quoted value where it is', () => {
    untouched('const A = `a::after { content: "draft /* internal */ note"; }`;');
  });

  it('leaves a /* … */ inside a single-quoted value where it is', () => {
    untouched("const A = `a::after { content: 'draft /* internal */ note'; }`;");
  });

  it('leaves a /* … */ inside a url() string where it is', () => {
    untouched('const A = `a { background: url("https://x.example/a /* b */ c.png"); }`;');
  });

  it('leaves a /* … */ inside a custom property holding a string', () => {
    untouched('const A = `:host { --dh-label: "a /* b */ c"; }`;');
  });

  it('reads a */ inside a string as content, and still strips the comment beside it', () => {
    expect(strip('const A = `a { content: "*/ x"; /* c */ color: red; }`;')).toBe(
      'const A = `a { content: "*/ x"; color: red; }`;',
    );
  });

  // A CSS string ends at ITS OWN quote. The other kind is content, which is
  // how an apostrophe gets into `content:` prose at all.
  it('does not let the other quote close a string', () => {
    untouched('const A = `a { content: "it\'s /* x */ fine"; }`;');
    untouched('const A = `a { content: \'say "hi" /* x */\'; }`;');
  });

  // Two escaping levels stack inside a template literal, and both have to be
  // read or the scan leaves the string in the wrong place.
  it('honours the template escape that puts a backtick or a ${ inside a string', () => {
    untouched('const A = `a { content: "a \\` b /* c */ d"; }`;');
    untouched('const A = `a { content: "a \\${x} /* c */ d"; }`;');
  });

  it('honours a CSS-escaped quote, which does not end the string', () => {
    untouched('const A = `a { content: "a \\\\" is not the end /* c */"; }`;');
  });

  // A quote can arrive ESCAPED. Source `\"` is a plain `"` in the sheet, so
  // it opens a string like any other — and nobody writing CSS in a template
  // literal has a reason to type it, which is exactly what would make it the
  // one shape left unguarded.
  it('sees a string opened by an escaped quote', () => {
    untouched('const A = `a { content: \\"x /* y */\\"; }`;');
  });

  it('still strips the comments on either side of a string it steps over', () => {
    expect(strip('const A = `a { /* one */ content: "x /* y */"; /* two */ color: red; }`;')).toBe(
      'const A = `a { content: "x /* y */"; color: red; }`;',
    );
  });

  // `cssUrl` in `src/ui/styles.ts` returns exactly this shape: a string with
  // a `${…}` running through it. There is nothing to delete in it, so the
  // fallback is invisible here — the test below is the one that shows what
  // the fallback actually costs.
  it('does not try to step over a string an interpolation runs through', () => {
    const source = 'const A = `a { background: url("${x}"); }`;';
    expect(strip(source)).toBe(source);
  });

  // The BOUND on all of the above, characterised rather than left to be
  // discovered. A string the scan cannot delimit is read as if the quote were
  // an ordinary character — the behaviour this loop had before it knew about
  // strings — so a `/*` inside one is still deleted. Nothing in
  // `src/ui/styles.ts` is this shape, and if it ever becomes this shape two
  // checks in this file fail: the byte comparison (its reference strip IS
  // string-aware, so it keeps what this drops) and the standing precondition
  // that no quoted string in the sheet carries a `/*`. Delete this test the
  // day the scan carries string state across an interpolation.
  it('does NOT see a string an interpolation runs through — the known bound', () => {
    expect(strip('const A = `a { content: "x /* y */ ${z}"; }`;')).toBe(
      'const A = `a { content: "x ${z}"; }`;',
    );
  });
});

// The oracle the equivalence comparison above rests on, tested in its own
// right. It is only a reference if it can DISAGREE with the transform; a
// reference that shares the transform's blind spot certifies the blind spot.
describe('the reference strip steps over CSS strings too', () => {
  it('leaves a /* … */ inside a string, in either quote', () => {
    const dq = 'a::after { content: "draft /* internal */ note"; }';
    const sq = "a::after { content: 'draft /* internal */ note'; }";
    expect(stripCssCommentsFromCss(dq)).toBe(dq);
    expect(stripCssCommentsFromCss(sq)).toBe(sq);
  });

  it('leaves a */ inside a string, and a /* inside a url()', () => {
    const css = 'a { content: "*/ x"; background: url("https://x.example/a /* b */ c.png"); }';
    expect(stripCssCommentsFromCss(css)).toBe(css);
  });

  it('does not let the other quote, or an escaped one, close a string', () => {
    const apostrophe = 'a { content: "it\'s /* x */ fine"; }';
    const quote = "a { content: 'say \"hi\" /* x */'; }";
    const escaped = 'a { content: "a \\" /* x */ b"; }';
    expect(stripCssCommentsFromCss(apostrophe)).toBe(apostrophe);
    expect(stripCssCommentsFromCss(quote)).toBe(quote);
    expect(stripCssCommentsFromCss(escaped)).toBe(escaped);
  });

  // A backtick and a `${` are ordinary CSS content once the sheet is a string
  // — the template literal they came from is long gone by here.
  it('leaves a backtick or a ${ inside a string alone', () => {
    const css = 'a { content: "a ` b ${x} /* c */ d"; }';
    expect(stripCssCommentsFromCss(css)).toBe(css);
  });

  it('still removes the real comments on either side of a string', () => {
    expect(stripCssCommentsFromCss('a { /* one */ content: "x /* y */"; /* two */ color: red; }')).toBe(
      'a {  content: "x /* y */";  color: red; }',
    );
  });

  // The failure this replaced: the blind regex agrees with a corrupted sheet,
  // so the byte comparison would have passed on the one bug the transform is
  // able to cause.
  it('disagrees with the blind regex exactly where the blind regex is wrong', () => {
    const css = 'a::after { content: "draft /* internal */ note"; }';
    expect(stripCssCommentsFromCss(css)).toBe(css);
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).toBe('a::after { content: "draft  note"; }');
  });
});

describe('the stylesheet source stays inside what the transform can strip', () => {
  // The precondition the equivalence comparison rests on. If someone writes
  // `.a/* c */.b` the transform will (correctly) leave it, the reference
  // regex will remove it, and the byte comparison above turns into a puzzle.
  // Fail here instead, with the reason.
  it('has whitespace beside every comment, so every comment is strippable', () => {
    const result = stripCssComments(readFileSync(stylesSource, 'utf8'), { filename: stylesSource });
    expect(result.kept).toBe(0);
    expect(result.removed).toBeGreaterThan(100);
  });

  // The other precondition, and the one the equivalence comparison silently
  // rested on until it was written down: `/*` inside a quoted string is
  // CONTENT. The transform steps over such strings and the oracle above does
  // too, so they would agree — but they would agree about a shape nobody has
  // read. Assert the sheet contains none, and the day someone writes
  // `content: "a /* b */ c"` this says so by name.
  it('writes no quoted string holding a comment delimiter', () => {
    const strings = quotedStrings(STYLES);
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.filter((text) => text.includes('/*') || text.includes('*/'))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The two shipped artifacts. These are the only checks that see both build
// paths, and the only ones that fail if the plugin is wired into one and
// forgotten in the other.
// ─────────────────────────────────────────────────────────────────────────

/**
 * A line of comment prose from each block in the sheet, long enough to be
 * unmistakable and free of characters a JS string escapes — so the same bytes
 * would appear verbatim in a minified bundle if the block were still there.
 *
 * Enumerated with the blind regex on purpose: this needs a SUPERSET of the
 * real comments, and the precondition that no quoted string in the sheet
 * holds a `/*` is what says the two sets are the same one here.
 */
function commentProbes(): string[] {
  const probes: string[] = [];
  for (const block of STYLES.match(/\/\*[\s\S]*?\*\//g) ?? []) {
    const line = block
      .split('\n')
      .map((part) => part.replace(/^[\s*/]+|[\s*/]+$/g, '').trim())
      .filter((part) => part.length >= 30 && !/["'\\`$]/.test(part))
      .sort((a, b) => b.length - a.length)[0];
    if (line !== undefined) probes.push(line);
  }
  return probes;
}

function readArtifact(name: string): string {
  const file = join(packageRoot, 'dist', name);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `dist/${name} is missing. Run \`pnpm --filter @dhaam-ccrm/widget build\` first — ` +
        'CI builds before it tests for the same reason.',
    );
  }
}

describe.each([
  ['widget.js', 'the <script src> bundle'],
  ['index.js', 'the npm package entry'],
  ['index.cjs', 'the npm package entry, CommonJS'],
])('dist/%s — %s', (name) => {
  it('ships none of the stylesheet comment prose', () => {
    const artifact = readArtifact(name);
    const probes = commentProbes();
    expect(probes.length).toBeGreaterThan(100);
    expect(probes.filter((probe) => artifact.includes(probe))).toEqual([]);
  });

  // The other half of the claim: the strip removed comments and nothing else.
  // Load-bearing CSS from three different regions of the sheet — a rule name,
  // a custom property the straddle owns, and a dark-palette value that only
  // reaches the browser through a `${…}` interpolation.
  //
  // Asserted as presence, not as a count: esbuild does not fold
  // `${DARK_TOKENS}` into the literal in either build, so the dark palette is
  // still a separate constant here and appears once. That BOTH interpolation
  // sites survive is an evaluated claim, and is proven above against the
  // stripped module rather than guessed at from a bundle's text.
  it('still ships the stylesheet itself', () => {
    const artifact = readArtifact(name);
    expect(artifact).toContain('--dh-band-straddle');
    expect(artifact).toContain('.dh-brand-band');
    expect(artifact).toContain('--dh-mesh-bg: #1c1a24');
    expect(artifact).toContain('--dh-accent');
  });
});

describe('both build paths register the transform', () => {
  // A STATIC-ASSET check, and labelled as one: it reads the two config files
  // as text. It cannot prove the plugin ran — the dist checks above do that —
  // but it names the file that is missing the registration, which a byte
  // comparison against a bundle never would.
  it.each([
    ['scripts/bundle.mjs'],
    ['tsup.config.ts'],
  ])('%s imports the shared transform', (file) => {
    const text = readFileSync(join(packageRoot, file), 'utf8');
    expect(text).toContain('strip-css-comments');
    expect(text).toContain('stripCssCommentsPlugin');
  });
});
