// Removes the stylesheet's CSS block comments at BUILD time, from both build
// paths, without removing them from the source a developer reads.
//
// ── Why a build step and not a source edit ────────────────────────────────
//
// `src/ui/styles.ts` holds the entire sheet in one template literal
// (`export const STYLES = \``). Its `/* … */` comments are therefore STRING
// DATA, not code comments. No minifier removes them — esbuild's
// `minify: true` and `legalComments: 'none'` both leave them exactly where
// they are, because to esbuild they are characters in a string, and deleting
// characters from a string would change what the program means.
//
// The measured cost of that: 134 blocks, 50,079 characters of source prose —
// what the build prints as `48.9 KB of source`. That is the SOURCE figure and
// it is not the bundle's: those 134 blocks are 56,194 raw bytes of
// `dist/widget.js`, because esbuild escapes the non-ASCII box-drawing this
// prose is ruled with as `\uXXXX`. Gzipped, they cost every visitor of every
// host page that embeds this widget 19,734 B. `scripts/bundle.mjs` holds the
// full before/after and rebuilds it on every build rather than quoting it.
//
// ── Why it lives here and not inside one of the two build entry points ────
//
// There are two artifacts and both ship the same string:
//
//   dist/widget.js  — the `<script src>` bundle (scripts/bundle.mjs, esbuild,
//                     minified, IIFE). This is the one the gzip budget gates.
//   dist/index.js   — the npm-package build (tsup, NOT minified). A consumer
//     dist/index.cjs  bundles this themselves, and because the comments are
//                     string data, THEIR minifier cannot remove them either.
//                     Fixing only the script tag would leave every npm
//                     consumer paying for all 134 blocks.
//
// So the transform has exactly one implementation with two registrations. It
// cannot live in `scripts/` (that directory holds executable entry points,
// and `tsup.config.ts` would then import a script with side effects) and it
// cannot live in `src/` (it is not shipped runtime code).
//
// ── Why this is safe, stated as an invariant rather than as care ──────────
//
// The transform is PURE DELETION of spans, and a span is only ever deleted
// when ALL of the following hold:
//
//   1. It begins `/*` and ends at the FIRST following `*/` — CSS comments do
//      not nest, so the first terminator is the right one.
//   2. It contains no backtick and no `${`. Enforced by construction (the
//      scan for `*/` aborts on either) and re-checked afterwards. This is
//      what makes "never swallow an interpolation" a guarantee rather than a
//      hope: `STYLES` interpolates `${DARK_TOKENS}` twice, and eating one
//      would delete half the dark palette.
//   3. It was found while the lexer was inside TEMPLATE LITERAL TEXT — not
//      inside `${…}`, not inside a `'`/`"` JavaScript string, not inside a
//      regex literal, and not inside a JavaScript comment.
//   4. It was not inside a CSS STRING the scan can delimit. Between `"…"` or
//      `'…'` in the sheet a `/*` is CONTENT — `content: "draft /* internal
//      */ note"` renders those characters — so such strings are stepped over
//      whole, including one opened by an escaped quote and one carrying an
//      escaped quote.
//
//      The bound on that, stated rather than implied: where the scan CANNOT
//      say where a string ends — a `${…}` runs through it, or it is not
//      closed before the literal or the line is — it falls back to reading
//      the quote as an ordinary character, which is what it did before it
//      knew about strings, and a `/*` inside THAT string would still be
//      deleted. Nothing in the sheet is that shape, and two checks in
//      `test/styles-comment-strip.test.ts` fail if it ever becomes that
//      shape: the equivalence comparison, whose reference strip is itself
//      string-aware and so can disagree with this file, and the standing
//      precondition that no quoted string in the sheet carries a `/*`.
//
// Points 3 and 4 are why this is a small lexer and not a regex. What
// `src/ui/styles.ts` contains today, measured against it rather than
// asserted (the transform removes 134 blocks from this file and keeps 0):
//
//   * a REGEX LITERAL CONTAINING QUOTES — `/["'()\;\s]/` in `cssUrl`
//     (styles.ts:216). The demonstrated one. A scanner that understands
//     strings but not regex literals reads that `"` as opening a string,
//     runs it to the `"` of the `url("${url}")` on the same line, and
//     swallows that literal's opening backtick. How far the damage travels
//     depends on the rest of the scanner: the variant whose strings also
//     cross newlines removes 0 of the 134 blocks.
//   * a REGEX LITERAL CONTAINING `*/` — `/[;{}()<>\\]|\/\*/` in `cssColor`
//     (styles.ts:396). The characters really are there, but none of the
//     cruder scanners tried against this file is broken by them. A hazard
//     SHAPE, not a present break.
//   * an UNBALANCED BACKTICK inside a JSDoc block — NOT present. All 152
//     `/* … */` blocks in the file, CSS and JavaScript alike, have an EVEN
//     number of backticks, the `cssUrl` doc that quotes a hostile URL
//     (`--a: ("`) included: it has ten. It is the shape that would invert
//     every template boundary after it, silently, which is why the suite
//     keeps a case for it anyway.
//
// So the honest argument for the lexer is FUTURE-PROOFING, not rescue. On
// today's file several cruder scanners — fully unaware, comment-aware,
// string-aware under JavaScript's own no-newline rule — produce the same 134
// deletions this one does, modulo whitespace runs. What earns it its place is
// that all three shapes above are ones a stylesheet module grows rather than
// exotica — one already breaks a half-aware scanner and another is present as
// characters — and that the failure they cause is silent and sheet-wide: a
// CSS parser discards what it cannot understand and keeps going, so nothing
// throws and a customer is the one who finds it.
//
// `//` is never treated as a comment inside template text, so a CSS
// `url(https://…)` — or any protocol-relative URL — is left alone.
//
// The worst case if the lexer were nonetheless wrong is bounded by the four
// conditions above: the only spans it can delete are well-formed comment
// blocks with no backtick and no interpolation in them. Deleting one of those
// from JavaScript code removes a JS comment, which is inert. The equivalence
// test (`test/styles-comment-strip.test.ts`) then compares the built sheet
// against a reference strip made by a DIFFERENT mechanism — CSS-string-aware,
// so it can disagree with this file rather than share its assumptions — and
// holds the sheet to a standing precondition that no quoted string in it
// carries a `/*`, which is the one shape that comparison could not see.
//
// ── The one shape that is deliberately NOT stripped ───────────────────────
//
// A comment with no whitespace on either side, e.g. `.a/* c */.b`. In CSS a
// comment produces no token, so `.a/* c */.b` is the COMPOUND selector
// `.a.b`, while `.a .b` is a descendant selector — two different rules.
// Deleting the comment and deleting-then-spacing it are both meaning changes
// in some position, so this transform leaves that shape exactly where it is
// and reports the count. The sheet contains none today, and
// `test/styles-comment-strip.test.ts` asserts that it still contains none, so
// the choice costs nothing and cannot silently start costing something.

import { readFile } from 'node:fs/promises';

/** The file whose template literals are the stylesheet. */
export const STYLESHEET_FILTER = /[\\/]src[\\/]ui[\\/]styles\.ts$/;

/** Identifiers that may legally be followed by a regex literal. */
const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

const IDENT = /[A-Za-z0-9_$]/;
const WS = /\s/;

/**
 * @typedef {object} StripResult
 * @property {string} code           the source with CSS comments deleted
 * @property {number} removed        comment blocks deleted
 * @property {number} kept           blocks left in place (see the header)
 * @property {number} bytesRemoved   source bytes the deletion saved
 */

/**
 * Deletes CSS block comments from every template literal in `source`.
 *
 * Throws rather than guessing on a malformed sheet: an unterminated `/*`, or
 * one whose `*` + `/` lies past a `${` or past the end of the literal. Both
 * mean the stylesheet is already broken (the CSS parser would swallow the
 * rest of the sheet), and failing the build says so where a silent partial
 * strip would not.
 *
 * @param {string} source
 * @param {{ filename?: string }} [options]
 * @returns {StripResult}
 */
export function stripCssComments(source, options = {}) {
  const where = options.filename ?? '<source>';
  /** @type {string[]} */
  const out = [];
  /** @type {Array<{ kind: 'tpl' } | { kind: 'itp', depth: number }>} */
  const stack = [];
  /** @type {Array<{ start: number, end: number }>} */
  const cuts = [];

  let copied = 0;
  let regexAllowed = true;
  let removed = 0;
  let kept = 0;
  let i = 0;

  const top = () => stack[stack.length - 1];

  while (i < source.length) {
    const inTemplateText = top()?.kind === 'tpl';

    if (inTemplateText) {
      const ch = source[i];
      if (ch === '\\') {
        // An escape, consumed as one character — except when the character it
        // produces is a quote, because source `\"` is a plain `"` in the sheet
        // and opens a CSS string exactly like an unescaped one. Nobody writing
        // CSS in a template literal has a reason to type that, which is what
        // would make it the one string shape left unguarded.
        const quote = source[i + 1];
        if (quote === '"' || quote === "'") {
          const end = endOfCssString(source, i + 1, quote);
          if (end !== -1) {
            i = end;
            continue;
          }
        }
        i += 2;
        continue;
      }
      if (ch === '`') {
        stack.pop();
        regexAllowed = false;
        i += 1;
        continue;
      }
      if (ch === '$' && source[i + 1] === '{') {
        stack.push({ kind: 'itp', depth: 0 });
        regexAllowed = true;
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        // A CSS STRING, stepped over whole. `/*` between quotes is CONTENT,
        // not a comment opener, and deleting it changes what the page says.
        //
        // When the scan cannot say where the string ends — a `${…}` runs
        // through it, it is not closed before the template literal is, or a
        // bare newline ends it the way the CSS parser would — the quote is
        // read as an ordinary character, which is what this loop did before
        // it knew about strings at all. Condition 4 in the header says what
        // that fallback does and does not cover, and which two tests fail if
        // the sheet ever depends on it.
        const end = endOfCssString(source, i, ch);
        if (end !== -1) {
          i = end;
          continue;
        }
      }
      if (ch === '/' && source[i + 1] === '*') {
        const end = closingOf(source, i, where);
        // Whitespace policy, in three cases, because CSS whitespace is
        // significant in exactly the places a careless collapse ruins:
        // `.a .b` is a descendant selector and `.a.b` is a compound one.
        //
        //   whitespace BEFORE  — the run in front already separates the
        //     tokens, so the comment AND the run behind it can go. This is the
        //     case for every comment in the sheet and where the saving is.
        //   whitespace only AFTER — that run is the only separator there is.
        //     Take the comment and leave the run standing, or `.a/* c */ .b`
        //     silently becomes `.a.b`.
        //   NEITHER — the comment is itself the token boundary. Removing it
        //     joins two tokens and replacing it with a space invents a
        //     descendant combinator. Left exactly where it is, and counted.
        const spacedBefore = i > 0 && WS.test(source[i - 1] ?? '');
        const spacedAfter = WS.test(source[end] ?? '');
        if (spacedBefore || spacedAfter) {
          let cutEnd = end;
          if (spacedBefore) {
            while (cutEnd < source.length && WS.test(source[cutEnd] ?? '')) cutEnd += 1;
          }
          cuts.push({ start: i, end: cutEnd });
          out.push(source.slice(copied, i));
          copied = cutEnd;
          removed += 1;
          i = cutEnd;
        } else {
          kept += 1;
          i = end;
        }
        continue;
      }
      i += 1;
      continue;
    }

    // Ordinary JavaScript/TypeScript context, including inside `${…}`.
    const ch = source[i];

    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) i = source.length;
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      // A real JavaScript comment. esbuild's minifier drops it; this
      // transform deliberately does not touch it.
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? source.length : close + 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i, ch, where);
      regexAllowed = false;
      continue;
    }

    if (ch === '`') {
      stack.push({ kind: 'tpl' });
      i += 1;
      continue;
    }

    if (ch === '/' && regexAllowed) {
      i = skipRegex(source, i, where);
      regexAllowed = false;
      continue;
    }

    if (ch === '{') {
      const t = top();
      if (t?.kind === 'itp') t.depth += 1;
      regexAllowed = true;
      i += 1;
      continue;
    }

    if (ch === '}') {
      const t = top();
      if (t?.kind === 'itp') {
        if (t.depth === 0) {
          stack.pop();
          i += 1;
          regexAllowed = false;
          continue;
        }
        t.depth -= 1;
      }
      regexAllowed = true;
      i += 1;
      continue;
    }

    if (IDENT.test(ch ?? '')) {
      let j = i;
      while (j < source.length && IDENT.test(source[j] ?? '')) j += 1;
      const word = source.slice(i, j);
      regexAllowed = KEYWORDS_BEFORE_REGEX.has(word);
      i = j;
      continue;
    }

    if (ch === ')' || ch === ']') {
      regexAllowed = false;
      i += 1;
      continue;
    }

    if (!WS.test(ch ?? '')) regexAllowed = true;
    i += 1;
  }

  out.push(source.slice(copied));
  const code = out.join('');

  assertDeletionsAreSafe(source, code, cuts, where);

  return { code, removed, kept, bytesRemoved: source.length - code.length };
}

/**
 * The index just past the `*\/` that closes the comment opening at `start`.
 * Aborts on anything that would make the deletion unsafe.
 */
function closingOf(source, start, where) {
  for (let i = start + 2; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '*' && source[i + 1] === '/') return i + 2;
    if (ch === '`') {
      throw new Error(
        `${where}: a CSS comment opened at offset ${start} runs past the end of its template literal. ` +
          'Close it, or the browser\'s CSS parser will swallow the rest of the sheet.',
      );
    }
    if (ch === '$' && source[i + 1] === '{') {
      throw new Error(
        `${where}: a CSS comment opened at offset ${start} runs into a \${…} interpolation. ` +
          'Refusing to delete it — that would remove a config value from the stylesheet.',
      );
    }
  }
  throw new Error(`${where}: unterminated CSS comment opened at offset ${start}.`);
}

/**
 * The index just past the quote that closes the CSS string opening at
 * `start`, or `-1` if this scan cannot say where that is.
 *
 * Two escaping levels stack inside a template literal and both are read here.
 * A `\` in the SOURCE is a template escape — it is how a backtick or a `${`
 * gets into the sheet at all — and the character it produces may itself be a
 * CSS escape: source `\"` is a plain `"` in the sheet and closes the string,
 * while source `\\"` is `\"` in the sheet, an escaped quote that does not.
 */
function endOfCssString(source, start, quote) {
  let cssEscaped = false;
  for (let i = start + 1; i < source.length; i += 1) {
    let ch = source[i];
    let fromEscape = false;
    if (ch === '\\') {
      if (i + 1 >= source.length) return -1;
      ch = source[i + 1];
      i += 1;
      fromEscape = true;
    }
    if (cssEscaped) {
      cssEscaped = false;
      continue;
    }
    // Only reachable from source `\\`, which is one backslash in the sheet:
    // a CSS escape covering whatever comes next, including a quote.
    if (ch === '\\') {
      cssEscaped = true;
      continue;
    }
    if (ch === quote) return i + 1;
    if (fromEscape) continue;
    // Past the end of the literal, into an interpolation whose end this scan
    // cannot see, or past the newline that ends an unterminated CSS string.
    // None of those is a span it may step over.
    if (ch === '`' || ch === '\n') return -1;
    if (ch === '$' && source[i + 1] === '{') return -1;
  }
  return -1;
}

function skipQuoted(source, start, quote, where) {
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === '\n') break;
  }
  throw new Error(`${where}: unterminated ${quote} string at offset ${start}.`);
}

function skipRegex(source, start, where) {
  let inClass = false;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      let j = i + 1;
      while (j < source.length && IDENT.test(source[j] ?? '')) j += 1;
      return j;
    } else if (ch === '\n') break;
  }
  throw new Error(`${where}: unterminated regex literal at offset ${start}.`);
}

/**
 * The safety net. Re-checks, on the finished output, the properties the scan
 * is supposed to have maintained — so a lexer bug fails the BUILD rather than
 * shipping a mangled stylesheet to every customer.
 */
function assertDeletionsAreSafe(source, code, cuts, where) {
  for (const cut of cuts) {
    const span = source.slice(cut.start, cut.end);
    const comment = span.replace(/\s+$/, '');
    if (!/^\/\*[\s\S]*\*\/$/.test(comment)) {
      throw new Error(`${where}: refusing to delete a span that is not a comment: ${JSON.stringify(span.slice(0, 60))}`);
    }
    if (comment.includes('`') || comment.includes('${')) {
      throw new Error(`${where}: refusing to delete a span containing a template delimiter.`);
    }
  }
  const count = (text, needle) => text.split(needle).length - 1;
  if (count(code, '`') !== count(source, '`')) {
    throw new Error(`${where}: the strip changed the number of backticks. Aborting.`);
  }
  if (count(code, '${') !== count(source, '${')) {
    throw new Error(`${where}: the strip changed the number of \${…} interpolations. Aborting.`);
  }
}

/**
 * The transform as an esbuild plugin, for `scripts/bundle.mjs` and for
 * `tsup.config.ts`'s `esbuildPlugins`.
 *
 * @param {{ onStrip?: (stats: { file: string, removed: number, kept: number, bytesRemoved: number }) => void }} [options]
 * @returns {import('esbuild').Plugin}
 */
export function stripCssCommentsPlugin(options = {}) {
  return {
    name: 'strip-css-comments',
    setup(build) {
      build.onLoad({ filter: STYLESHEET_FILTER }, async (args) => {
        const source = await readFile(args.path, 'utf8');
        // An anchor, not a formality: if the filter ever matches a file that
        // is not the stylesheet, the transform should not run on it silently.
        if (!source.includes('export const STYLES')) {
          throw new Error(`${args.path} matched the stylesheet filter but exports no STYLES.`);
        }
        const result = stripCssComments(source, { filename: args.path });
        options.onStrip?.({
          file: args.path,
          removed: result.removed,
          kept: result.kept,
          bytesRemoved: result.bytesRemoved,
        });
        return { contents: result.code, loader: 'ts' };
      });
    },
  };
}
