import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// FEA-2399 guard: keep the desktop `test:node` slice deterministic.
//
// The `desktop` CI job flaked non-deterministically because a test used a
// count-bounded poll loop as a completion barrier over real async I/O and then
// FELL THROUGH SILENTLY when the turn budget was exhausted — asserting a stale
// value under load instead of failing loudly. This guard forbids that shape:
// any async wait-for-condition helper (a function whose parameters include a
// `predicate`/`condition` callback and whose body loops) MUST `throw` when it
// gives up, so a missed signal surfaces as an explicit timeout, never a
// confusing stale-value assertion.
//
// It intentionally does NOT flag: fixed-count settle helpers (no predicate
// param, e.g. settleAsyncTurns), single-flush `await new Promise(r => ...)`
// (no loop), or the existing time-bounded helpers that already throw.

const THIS_FILE = "no-silent-poll-barrier.guard.test.ts";
const TEST_DIR = dirname(fileURLToPath(import.meta.url));

// Function headers: `async function name(` or `const name = async (`.
const FUNCTION_HEADER =
  /(?:async\s+function\s+([A-Za-z0-9_$]+)|(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*async)\s*\(/g;
const PREDICATE_PARAM = /\b(?:predicate|condition)\b/;
const LOOP_KEYWORD = /\b(?:for|while)\s*\(/;
const THROW_KEYWORD = /\bthrow\b/;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /(^|[^:])\/\/[^\n]*/g;

/** Remove comments so their words can't mask or mimic a `throw`/predicate. */
function stripComments(source: string): string {
  return source
    .replace(BLOCK_COMMENT, " ")
    .replace(LINE_COMMENT, (_match, prefix: string) => prefix);
}

/**
 * From an opening delimiter at `openIndex`, return the index of its matching
 * close, skipping delimiters inside string and template literals.
 */
function matchDelimiter(
  source: string,
  openIndex: number,
  open: string,
  close: string
): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === "\\") {
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

type Violation = { fn: string; reason: string };

/** Find silent poll-barrier helpers (predicate param + loop, but no throw). */
function findViolations(rawSource: string): Violation[] {
  const source = stripComments(rawSource);
  const violations: Violation[] = [];
  FUNCTION_HEADER.lastIndex = 0;
  let header = FUNCTION_HEADER.exec(source);
  while (header !== null) {
    const name = header[1] ?? header[2] ?? "<anonymous>";
    const parenOpen = header.index + header[0].length - 1;
    const parenClose = matchDelimiter(source, parenOpen, "(", ")");
    const braceOpen = source.indexOf("{", parenClose);
    if (parenClose !== -1 && braceOpen !== -1) {
      const params = source.slice(parenOpen + 1, parenClose);
      const braceClose = matchDelimiter(source, braceOpen, "{", "}");
      const body = source.slice(
        braceOpen,
        braceClose === -1 ? undefined : braceClose
      );
      const isWaitHelper =
        PREDICATE_PARAM.test(params) && LOOP_KEYWORD.test(body);
      if (isWaitHelper && !THROW_KEYWORD.test(body)) {
        violations.push({
          fn: name,
          reason:
            "predicate-polling wait helper must throw when its bound is exhausted (fail loud, not stale-value fall-through)",
        });
      }
    }
    header = FUNCTION_HEADER.exec(source);
  }
  return violations;
}

test("guard detector flags a silent predicate-poll helper", () => {
  const bad = `
    async function waitForImmediateCondition(predicate, maxTurns = 200) {
      for (let turn = 0; turn < maxTurns && !predicate(); turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  `;
  const violations = findViolations(bad);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].fn, "waitForImmediateCondition");
});

test("guard detector accepts a throwing (fail-loud) predicate-poll helper", () => {
  const good = `
    async function waitUntil(predicate) {
      const startedAt = Date.now();
      while (!predicate()) {
        if (Date.now() - startedAt > 2000) {
          throw new Error("timed out");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  `;
  assert.deepEqual(findViolations(good), []);
});

test("guard detector ignores fixed-count settle helpers (no predicate param)", () => {
  const settle = `
    async function settleAsyncTurns(turns) {
      for (let turn = 0; turn < turns; turn += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  `;
  assert.deepEqual(findViolations(settle), []);
});

test("guard detector ignores a `throw` that only appears in a comment", () => {
  const commentedThrow = `
    async function waitForCondition(predicate) {
      // NOTE: this used to throw on timeout but no longer does
      for (let turn = 0; turn < 100 && !predicate(); turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  `;
  assert.equal(findViolations(commentedThrow).length, 1);
});

test("no desktop test file reintroduces a silent poll-barrier", () => {
  const files = readdirSync(TEST_DIR).filter(
    (name) => name.endsWith(".test.ts") && name !== THIS_FILE
  );
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(TEST_DIR, file), "utf8");
    for (const violation of findViolations(source)) {
      offenders.push(`${file}: ${violation.fn} — ${violation.reason}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Silent poll-barrier(s) found:\n${offenders.join("\n")}`
  );
});
