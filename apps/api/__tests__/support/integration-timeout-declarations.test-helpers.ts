/**
 * ISS-8542 / ISS-8553 — the reader behind
 * `apps/api/__tests__/integration-suite-timeout-budget.test.ts`: every spelling
 * an integration suite can declare a timeout in, and the verdict on which of
 * them reach or exceed the bound the phase they are spent from answers to.
 *
 * It is split out of the guard because that file also owns the tier resolution,
 * the grandfather ledger, and two describes; at ~840 lines together they were
 * past the point where the repo asks for a seam. It sits under
 * `__tests__/support/` rather than `__tests__/utils/` because it serves ONE
 * module — `apps/api/AGENTS.md` reserves the flat `utils/` for app-wide
 * infrastructure consumed by tests of 3+ modules or wired into a vitest config.
 * Pure functions over source text, no vitest and no filesystem, so the synthetic
 * fixtures in the guard drive exactly the code the real tier assertion runs.
 *
 * ## Known blind spots
 *
 * Named here rather than left to silence, per requirement 4 in
 * `scripts/lint/AGENTS.md`: a reader that cannot see a shape must say so, or its
 * quiet reads as a clean tier.
 *
 * 1. **One declaration spent more than once in the same phase is counted
 *    once.** The walk records a `const TX = { timeout }` where it is DECLARED,
 *    not at each `await tx(TX)` that spends it, so a test awaiting the same
 *    hoisted literal twice sums to one budget rather than two. The inline form
 *    of that same test is caught, because two inline literals are two records.
 *    Nothing in the tier is live on this today — `TX_BUDGET`'s four uses and
 *    `TRANSACTION_OPTIONS`' two each sit in a different `it()` — and closing it
 *    needs use-site resolution, which is the same machinery blind spot 2 wants.
 * 2. **A bound written in a module the tier does not collect is read only if
 *    that module lives under `__tests__/`.** The guard walks the collected
 *    suites plus the transitive `__tests__/` modules they import, relatively or
 *    through the `@/` alias (see `localImportSpecifiers`), which is where fixture
 *    and helper modules go
 *    by `apps/api/AGENTS.md`. A declaration hoisted anywhere else — a support
 *    module outside `__tests__/`, a workspace package — is invisible, and the
 *    identifier at the use site is not reported as unresolved either, because a
 *    bare `$transaction(fn, OPTIONS)` names no timeout key for the walk to
 *    catch. Keep timeout declarations in the collected suite or in a
 *    `__tests__/` module it imports.
 */

import ts from "typescript6";

const NUMERIC_SEPARATOR_PATTERN = /_/g;

/**
 * Where the trailing numeric bound sits for each declaration form Vitest takes:
 * `it(name, fn, ms)` but `beforeAll(fn, ms)`. Hooks are here because a hook can
 * outlast the job exactly as a test can — the suite ISS-8542 localized the
 * stalls to seeds 17,000 rows in `beforeAll` — and a bound the guard cannot see
 * is a bound that does not exist.
 */
const TIMEOUT_ARGUMENT_INDEX_BY_CALLEE: ReadonlyMap<string, number> = new Map([
  ["it", 2],
  ["test", 2],
  ["beforeAll", 1],
  ["afterAll", 1],
  ["beforeEach", 1],
  ["afterEach", 1],
]);
const HOOK_CALLEE_NAMES = new Set([
  "beforeAll",
  "afterAll",
  "beforeEach",
  "afterEach",
]);
/**
 * Object keys that name a bound: `timeout` and `maxWait` on a Vitest options
 * object or a Prisma interactive transaction, and the two a suite can raise at
 * runtime through `vi.setConfig`.
 *
 * `maxWait` is here because it is spent from the SAME phase budget `timeout` is
 * and it is spent FIRST — Prisma waits up to `maxWait` for a pooled connection
 * before `BEGIN`, and only then arms the `timeout` clock. So the wall time a
 * transaction may occupy is their sum, and reading `timeout` alone let
 * `{ maxWait: 20_000, timeout: 25_000 }` declare 45s inside a 30s test: Vitest
 * fires first and the transaction runs on detached, which is the exact race
 * ISS-8542 was written about, arriving through the argument the guard did not
 * read.
 */
const TIMEOUT_PROPERTY_NAMES = new Set([
  "maxWait",
  "timeout",
  "testTimeout",
  "hookTimeout",
]);
export const OBJECT_PHASE_PREFIX = "object:";

/**
 * `either` is a bound whose awaiting phase this file cannot name — a
 * transaction option built at module scope and passed to whatever calls it.
 * Three collected suites already declare one, so it is the common shape rather
 * than the exotic one.
 */
export type DeclaredTimeout = {
  file: string;
  kind: "either" | "hook" | "test";
  milliseconds: number;
  /**
   * The phase whose budget this bound is SPENT FROM, identified by the start
   * offset of its call. `null` when the bound IS a phase's own budget (its
   * trailing argument or options object) or when no phase encloses it.
   *
   * The distinction is what makes summing safe. Bounds spent from one phase
   * run in sequence and add up against it; a phase's own budget is the thing
   * they are spent from and must never join its own sum.
   */
  phase: string | null;
};

function numericLiteralValue(node: ts.Node): number | null {
  if (!ts.isNumericLiteral(node)) {
    return null;
  }
  const parsed = Number(node.text.replace(NUMERIC_SEPARATOR_PATTERN, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Numeric `const`s declared in the file, so `{ timeout: SOME_MS }` is read
 * rather than skipped. Without this the bound is trivially defeated — and
 * silently, by the one refactor a suite is most likely to make — by naming the
 * number. `let`/`var` are deliberately excluded: only the initializer is
 * visible here, and a reassignment before use would resolve to a stale, smaller
 * value. They fall through to the unresolvable path below, which is loud.
 *
 * This is a FLAT map with no lexical scope, so a name that two `const`
 * declarations in the file disagree about is dropped rather than resolved to
 * whichever one the walk reached last. Keeping the last writer let a nested
 * `const TIMEOUT = 20_000` answer for an outer `const TIMEOUT = 60_000` and
 * carry the 60s declaration under the bound. Dropping it sends the use site to
 * the unresolvable path, which fails loudly and names the file — the same
 * trade the `let`/`var` exclusion above makes. Scope-tracking the whole file
 * would resolve both correctly; nothing in the tier needs that yet, and a
 * wrong number here is worse than a loud one.
 */
function numericConstants(sourceFile: ts.SourceFile): Map<string, number> {
  const declared = new Map<string, number | null>();
  const ambiguous = new Set<string>();
  const visit = (node: ts.Node): void => {
    const isConst =
      ts.isVariableDeclaration(node) &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.getFirstToken()?.kind === ts.SyntaxKind.ConstKeyword;
    if (isConst && ts.isIdentifier(node.name)) {
      const value = node.initializer
        ? numericLiteralValue(node.initializer)
        : null;
      const name = node.name.text;
      if (declared.has(name) && declared.get(name) !== value) {
        ambiguous.add(name);
      }
      declared.set(name, value);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const constants = new Map<string, number>();
  for (const [name, value] of declared) {
    if (value !== null && !ambiguous.has(name)) {
      constants.set(name, value);
    }
  }
  return constants;
}

function resolveNumeric(
  node: ts.Node,
  constants: Map<string, number>
): number | null {
  const literal = numericLiteralValue(node);
  if (literal !== null) {
    return literal;
  }
  if (ts.isIdentifier(node)) {
    return constants.get(node.text) ?? null;
  }
  return null;
}

function calleeName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  // `it.only`, `it.each(...)`, ``it.each`table` ``, `test.skipIf(...)` — the
  // root identifier is what says this is a test declaration, so walk down to it.
  if (ts.isPropertyAccessExpression(expression)) {
    return calleeName(expression.expression);
  }
  if (ts.isCallExpression(expression)) {
    return calleeName(expression.expression);
  }
  if (ts.isTaggedTemplateExpression(expression)) {
    return calleeName(expression.tag);
  }
  return "";
}

/**
 * The static name of a property key, in every spelling that can carry one.
 * Matching `ts.isIdentifier` alone skipped `{ "timeout": 60_000 }` and
 * `{ ["timeout"]: 90_000 }` outright — both ordinary JavaScript, and a quoted
 * key is what a paste from JSON lands as. A key this cannot read statically
 * (a template literal, a computed name built from an expression) returns null
 * and the declaration is skipped, so those spellings remain unread.
 */
function propertyKeyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
    return name.expression.text;
  }
  return null;
}

type PhaseAttribution = Pick<DeclaredTimeout, "kind" | "phase">;

/**
 * The nearest enclosing test or hook call, which is the phase that awaits a
 * `timeout` option written inside it. A hook bound is NOT a test bound: the
 * two are separate numbers, so reading a `beforeAll`'s transaction option
 * against `testTimeout` lets that hook outlive its own budget the moment the
 * tier lowers `hookTimeout` below `testTimeout`.
 *
 * Whether the bound is SPENT FROM that phase turns on how the walk reached it.
 * Arriving through the phase's callback means the bound is awaited inside the
 * phase's own budget, so it joins that phase's running sum. Arriving through
 * the argument list directly — `it(name, fn, 60_000)`, `it(name, { timeout },
 * fn)` — means the bound IS the budget, which cannot be spent from itself.
 */
function enclosingPhase(node: ts.Node): PhaseAttribution {
  let child: ts.Node = node;
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isCallExpression(current)) {
      const callee = calleeName(current.expression);
      const isHook = HOOK_CALLEE_NAMES.has(callee);
      if (isHook || TIMEOUT_ARGUMENT_INDEX_BY_CALLEE.has(callee)) {
        const throughCallback =
          current.arguments.some((argument) => argument === child) &&
          ts.isFunctionLike(child);
        return {
          kind: isHook ? "hook" : "test",
          phase: throughCallback ? String(current.getStart()) : null,
        };
      }
    }
    child = current;
    current = current.parent;
  }
  return { kind: "either", phase: null };
}

/** The object literal a property assignment is written in, if any. */
function enclosingObjectLiteral(
  node: ts.Node
): ts.ObjectLiteralExpression | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isObjectLiteralExpression(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * `hookTimeout` and `testTimeout` name their own phase outright; a bare
 * `timeout` or `maxWait` takes the phase it is written in. The two named forms
 * are `vi.setConfig` overrides — they SET a budget rather than spend one, so
 * they never join a phase's sum.
 *
 * A bound no phase encloses is grouped with its siblings in the object literal
 * that holds it, so a hoisted `const TX = { maxWait, timeout }` sums the way the
 * same pair written inline does. Without that, moving the options object to
 * module scope — which three collected suites had already done — split the pair
 * into two bounds that each cleared the tier alone while their sum did not.
 * Only the unattributed case takes this key: an options object sitting in a
 * test's own argument list is that phase's budget, and a budget must never be
 * spent from itself.
 */
function timeoutPropertyAttribution(
  name: string,
  node: ts.Node
): PhaseAttribution {
  if (name === "hookTimeout") {
    return { kind: "hook", phase: null };
  }
  if (name === "testTimeout") {
    return { kind: "test", phase: null };
  }
  const attribution = enclosingPhase(node);
  if (attribution.kind !== "either" || attribution.phase !== null) {
    return attribution;
  }
  const literal = enclosingObjectLiteral(node);
  return literal
    ? { kind: "either", phase: `${OBJECT_PHASE_PREFIX}${literal.getStart()}` }
    : attribution;
}

/**
 * Every spelling that declares a bound: the trailing argument Vitest takes on a
 * test or hook, the `timeout` option Prisma's interactive transactions take (a
 * transaction bound above the test bound is the same defect wearing a different
 * name, because the test cannot fail until the transaction does), and the
 * `testTimeout`/`hookTimeout` a suite can set at runtime via `vi.setConfig`.
 *
 * A declaration whose value this cannot resolve to a number is reported as
 * UNRESOLVED, never dropped. Dropping is what makes a source guard worthless:
 * `{ timeout: 30_000 * 6 }`, a constant imported from another module, and
 * `30_000 as const` would each read as "this file declares nothing" and sail
 * through the bound. Loud beats clever — a new spelling fails this guard and
 * gets taught to it, rather than silently unpinning the tier.
 */
export function declaredTimeoutsIn(
  file: string,
  source: string
): { resolved: DeclaredTimeout[]; unresolved: string[] } {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const constants = numericConstants(sourceFile);
  const resolved: DeclaredTimeout[] = [];
  const unresolved: string[] = [];
  const record = (
    node: ts.Node,
    attribution: PhaseAttribution,
    value: number | null
  ): void => {
    if (value === null) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart()
      );
      unresolved.push(`${file}:${line + 1} — ${node.getText()}`);
      return;
    }
    resolved.push({ file, ...attribution, milliseconds: value });
  };
  const visit = (node: ts.Node): void => {
    const propertyKey = ts.isPropertyAssignment(node)
      ? propertyKeyName(node.name)
      : null;
    if (
      ts.isPropertyAssignment(node) &&
      propertyKey !== null &&
      TIMEOUT_PROPERTY_NAMES.has(propertyKey)
    ) {
      record(
        node.initializer,
        timeoutPropertyAttribution(propertyKey, node),
        resolveNumeric(node.initializer, constants)
      );
    }
    // `{ timeout }` is `{ timeout: timeout }` with the initializer elided, and
    // the elision makes it a ShorthandPropertyAssignment — a different node
    // kind the branch above never sees. Skipping it let a suite bypass the
    // bound outright by naming its transaction option after the constant that
    // holds it, which is the shape a `const timeout = 60_000` refactor lands in
    // by default.
    if (
      ts.isShorthandPropertyAssignment(node) &&
      TIMEOUT_PROPERTY_NAMES.has(node.name.text)
    ) {
      record(
        node,
        timeoutPropertyAttribution(node.name.text, node),
        resolveNumeric(node.name, constants)
      );
    }
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      const index = TIMEOUT_ARGUMENT_INDEX_BY_CALLEE.get(callee);
      const trailing =
        index === undefined ? undefined : node.arguments.at(index);
      // Vitest also takes `it(name, { timeout }, fn)`, which puts the options
      // object in slot two and the CALLBACK in the slot this rule reads. The
      // property rule above has already read that object, so parsing the slot
      // as well reported the callback as an unresolvable bound and failed the
      // guard on a legal declaration — a guard that reds on correct code is one
      // the next author weakens rather than obeys.
      const options = node.arguments.at(1);
      const declaresOptions =
        options !== undefined && ts.isObjectLiteralExpression(options);
      // An options object in that slot (`it(name, fn, { timeout, retry })`) is
      // already read by the property rule above; recording it here would report
      // the object itself as an unresolvable bound.
      if (
        trailing &&
        !declaresOptions &&
        !ts.isObjectLiteralExpression(trailing)
      ) {
        record(
          trailing,
          // The phase's OWN budget, sitting in its argument list — never a
          // bound spent from it, so it carries no phase and joins no sum.
          {
            kind: HOOK_CALLEE_NAMES.has(callee) ? "hook" : "test",
            phase: null,
          },
          resolveNumeric(trailing, constants)
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { resolved, unresolved };
}

/**
 * The bound a declaration answers to. An exhaustive Record rather than a chain
 * of comparisons, so a new kind fails `tsc` here instead of silently taking
 * some default branch's bound.
 */
function boundForKind(
  kind: DeclaredTimeout["kind"],
  bounds: { hookTimeout: number; testTimeout: number }
): number {
  const byKind: Record<DeclaredTimeout["kind"], number> = {
    hook: bounds.hookTimeout,
    test: bounds.testTimeout,
    // Awaited by a phase this file cannot name, so held to whichever bound is
    // stricter. Picking the looser one would be choosing to be wrong in the
    // direction that lets the job get reaped.
    either: Math.min(bounds.hookTimeout, bounds.testTimeout),
  };
  return byKind[kind];
}

/**
 * Bounds spent from the same phase, added up. Two 20s transactions awaited in
 * sequence inside one test each pass a per-declaration check and still cannot
 * both finish: if the first spends 11s, Vitest reaps the test at its 30s bound
 * while the second transaction's own clock still has a second left, which is
 * the detached transaction this guard exists to prevent. The phase's own budget
 * carries no phase id, so it never lands in a group and never sums with the
 * bounds spent from it.
 */
function totalledByPhase(declared: DeclaredTimeout[]): DeclaredTimeout[] {
  const byPhase = new Map<string, DeclaredTimeout>();
  const standalone: DeclaredTimeout[] = [];
  for (const entry of declared) {
    if (entry.phase === null) {
      standalone.push(entry);
      continue;
    }
    const key = `${entry.file}:${entry.phase}`;
    const running = byPhase.get(key);
    byPhase.set(
      key,
      running
        ? {
            ...running,
            milliseconds: running.milliseconds + entry.milliseconds,
          }
        : entry
    );
  }
  return [...standalone, ...byPhase.values()];
}

/**
 * Worst DECLARED value per file, counting only the ones that reach their own
 * bound — a hook is bounded by `hookTimeout` and a test by `testTimeout`, so
 * comparing both against one number would misreport whichever bound is the
 * smaller.
 *
 * `>=`, not `>`. Equality is the race rather than the safe edge: Prisma arms a
 * transaction's clock after BEGIN, later than Vitest arms the test's, so at
 * equal values Vitest always fails first and leaves the transaction running
 * detached, holding a pooled connection and naming nothing. The guard's own
 * prose claimed strict inequality while the comparison allowed equality, and
 * the equal case is the one the PR was written about.
 */
export function worstOverBoundByFile(
  declared: DeclaredTimeout[],
  bounds: { hookTimeout: number; testTimeout: number }
): Map<string, number> {
  const worst = new Map<string, number>();
  for (const entry of totalledByPhase(declared)) {
    if (entry.milliseconds >= boundForKind(entry.kind, bounds)) {
      worst.set(
        entry.file,
        Math.max(worst.get(entry.file) ?? 0, entry.milliseconds)
      );
    }
  }
  return worst;
}

const LOCAL_SPECIFIER_PATTERN = /^(?:\.{1,2}\/|@\/)/;

/**
 * The specifiers a source imports or re-exports that name a module INSIDE this
 * package, so the guard can follow a timeout declaration into the fixture module
 * that holds it. Two spellings reach the same tree and both are returned: a
 * relative path, and the `@/` alias `apps/api/AGENTS.md` tells consumers to
 * import support through. Reading only the first was ISS-8553: 31 of the tier's
 * 104 collected suites import their support through `@/`, so every module they
 * reached that way sat outside the walk and any bound hoisted into one was
 * unreadable.
 *
 * Only static top-level forms: a dynamic `import()` is resolved at runtime, and a
 * bare or `@repo/` specifier leaves this package — neither is followed.
 *
 * Source text in, specifiers out — the caller owns resolving them against the
 * filesystem and deciding which are in scope, so this file stays pure.
 */
export function localImportSpecifiers(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    const moduleSpecifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    if (
      moduleSpecifier &&
      ts.isStringLiteral(moduleSpecifier) &&
      LOCAL_SPECIFIER_PATTERN.test(moduleSpecifier.text)
    ) {
      specifiers.push(moduleSpecifier.text);
    }
  }
  return specifiers;
}
