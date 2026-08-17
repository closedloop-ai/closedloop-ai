/**
 * ISS-4933 — `node:test`'s lifecycle surface, re-expressed on Vitest.
 *
 * `vitest.node.config.ts` aliases `node:test` onto this module, so the ~800
 * desktop main-process suites run under Vitest — and therefore report to
 * Datadog Test Optimization — without a single test body changing. That is the
 * point, not a shortcut: the alternative was rewriting the import line of every
 * file in `apps/desktop/test`, and a per-file rewrite of a directory that grew
 * 616 → 899 files in nine days can never converge. Here the runner is what
 * moved, so a file written tomorrow in the house `node:test` style is picked up
 * by Vitest the moment it lands, with no migration step at all.
 *
 * Because the test bodies are byte-identical either side of the change, the
 * assertions cannot silently weaken — the usual hazard of a test-framework
 * migration is simply absent. Both runners execute the same source.
 *
 * SCOPE. This covers the lifecycle exports only. `mock` (and the `TestContext`
 * parameter, whose `t.mock`/`t.after`/`t.diagnostic` have no Vitest analogue)
 * is deliberately NOT implemented: node:test's mock call records have a
 * different shape from `vi.fn()`'s, so faking them would be a translation layer
 * that lies about what the assertions are checking. Files using either stay on
 * the temporary `node:test` runner — see `scripts/node-test-census.mjs`, which
 * is what routes them, and ISS-4934, which converts them.
 */

import {
  afterAll,
  beforeAll,
  afterEach as vitestAfterEach,
  beforeEach as vitestBeforeEach,
  describe as vitestDescribe,
  test as vitestTest,
} from "vitest";

/** The subset of node:test's options object this tree actually uses. */
type NodeTestOptions = {
  concurrency?: number | boolean;
  only?: boolean;
  skip?: boolean | string;
  todo?: boolean | string;
  timeout?: number;
};

type TestBody = () => void | Promise<void>;
type HookBody = () => void | Promise<void>;

type NodeTestFn = {
  (name: string, options: NodeTestOptions, body: TestBody): void;
  (name: string, body: TestBody): void;
  skip: (name: string, body: TestBody) => void;
  /**
   * `test.after(fn)` — node:test hangs its file-level hooks off the suite
   * function as well as exporting them standalone, and 13 files in this tree use
   * that spelling. Same semantics as the standalone `after`.
   */
  after: (body: HookBody, options?: { timeout?: number }) => void;
  before: (body: HookBody, options?: { timeout?: number }) => void;
  beforeEach: (body: HookBody, options?: { timeout?: number }) => void;
  afterEach: (body: HookBody, options?: { timeout?: number }) => void;
};

/**
 * The slice of Vitest's `test`/`describe` this file uses.
 *
 * Not `typeof vitestTest | typeof vitestDescribe`: those are chainable
 * (`.each`, `.for`, `.concurrent`, …) generic types whose call signatures are
 * mutually incompatible, so a union of the two is not callable at all — `tsc`
 * rejects `suite(name, body)` outright. Naming the four members actually
 * needed is both narrower and what the mapping is really written against.
 */
type SuiteRegistrar = {
  (name: string, body: TestBody, timeout?: number): void;
  skip: (name: string, body: TestBody, timeout?: number) => void;
  only: (name: string, body: TestBody, timeout?: number) => void;
  todo: (name: string, body?: TestBody, timeout?: number) => void;
};

/**
 * node:test spells "don't run this" three ways — an `options` flag, a `.skip`
 * property, and a `todo`. Vitest spells the same three as separate callables,
 * so the options form has to be routed to the matching one rather than passed
 * through.
 */
function dispatch(
  suite: SuiteRegistrar,
  name: string,
  options: NodeTestOptions,
  body: TestBody
): void {
  // A string `skip` is node:test's reason argument, and truthy. `skip` is the
  // one of the three that means the same thing on both runners: the body does
  // not execute, and the case is reported as skipped.
  if (options.skip !== undefined && options.skip !== false) {
    suite.skip(name, body, options.timeout);
    return;
  }
  if (
    (options.todo !== undefined && options.todo !== false) ||
    options.only === true
  ) {
    // THROW rather than map. Both of these mean materially different things on
    // the two runners, and both differences are silent:
    //
    //   `todo` — node:test RUNS the body and merely tolerates its failure;
    //     Vitest's `test.todo` never invokes it. Mapping it would quietly stop
    //     executing a test that used to execute.
    //   `only` — without `--test-only`, which this suite does not pass,
    //     node:test treats it as a no-op and runs every sibling. Vitest's
    //     `.only` suppresses them (and, locally, does so silently — `allowOnly`
    //     is only false under CI).
    //
    // Neither is used in this tree today. If one arrives, the author should see
    // this rather than a green run that means something else.
    throw new Error(
      `[node-test-vitest-shim] "${name}" uses node:test's ${options.only === true ? "only" : "todo"} option, which has no faithful Vitest equivalent — node:test and Vitest disagree about whether the body runs and whether siblings are suppressed. Express it with \`{ skip: true }\` if the intent is "do not run this", or move the file to the node:test lane via VITEST_INCOMPATIBLE_FILES in scripts/node-test-census.mjs.`
    );
  }
  // `concurrency` is deliberately dropped rather than mapped to Vitest's
  // `.concurrent`. In node:test it bounds how many SUBTESTS of this test may
  // overlap; Vitest's `.concurrent` makes the test itself overlap its
  // siblings, which is a different (and, applied here, wrong) statement. The
  // desktop suite gets its parallelism from file-level isolation either way.
  suite(name, body, options.timeout);
}

function makeSuite(suite: SuiteRegistrar): NodeTestFn {
  function shimmed(
    name: string,
    optionsOrBody: NodeTestOptions | TestBody,
    maybeBody?: TestBody
  ): void {
    if (typeof optionsOrBody === "function") {
      suite(name, optionsOrBody);
      return;
    }
    if (maybeBody === undefined) {
      // node:test treats a body-less test as a todo; without this it would
      // silently pass.
      suite.todo(name);
      return;
    }
    dispatch(suite, name, optionsOrBody, maybeBody);
  }
  // No `.only` / `.todo`: `SHIMMED_NODE_TEST_PROPERTIES` in the census does not
  // list them either, so a file spelling them as properties is routed to the
  // node:test lane rather than reaching this object. See `dispatch` for why the
  // two runners cannot agree on what they mean.
  return Object.assign(shimmed as NodeTestFn, {
    skip: (name: string, body: TestBody) => suite.skip(name, body),
    after: makeHook(afterAll),
    before: makeHook(beforeAll),
    beforeEach: makeHook(vitestBeforeEach),
    afterEach: makeHook(vitestAfterEach),
  });
}

/**
 * node:test's hooks take `(fn, options)`; Vitest's take `(fn, timeout)`.
 *
 * `before`/`after` map to `beforeAll`/`afterAll`, not to the per-test hooks:
 * node:test runs them once per enclosing suite, which is `beforeAll`'s
 * semantics. Getting this backwards is the one mapping that would change
 * behaviour rather than fail loudly, so it is asserted in
 * `test/node-test-vitest-shim.test.ts`.
 */
function makeHook(
  hook: typeof beforeAll
): (body: HookBody, options?: { timeout?: number }) => void {
  return (body, options) => {
    hook(body, options?.timeout);
  };
}

export const test = makeSuite(vitestTest as SuiteRegistrar);
/**
 * node:test's default export IS `test` — `import test from "node:test"`, which
 * 83 files in this tree spell that way.
 *
 * Safe to hand them the same object the named export gives: the real default
 * also carries `.mock`, but the census's unshimmed-PROPERTY rule reads every
 * property access off a node:test binding regardless of how it was imported, so
 * a file that reaches for `test.mock` is routed to the legacy lane before it can
 * reach this module. The default form is not a weaker signal than the named one;
 * it was only ever rejected because the property rule was not being trusted to
 * cover it. A NAMESPACE import stays rejected — `import * as nodeTest` makes
 * `nodeTest.mock` indistinguishable from the module's own export shape.
 */
export default test;
export const it = test;
export const describe = makeSuite(vitestDescribe as SuiteRegistrar);
export const before = makeHook(beforeAll);
export const after = makeHook(afterAll);
export const beforeEach = makeHook(vitestBeforeEach);
export const afterEach = makeHook(vitestAfterEach);
