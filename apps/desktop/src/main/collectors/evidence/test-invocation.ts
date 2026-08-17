/**
 * @file test-invocation.ts
 * @description FEA-4010 (AA-09, test detection): does a shell command line RUN a
 * test suite? Replaces a substring alternation over 13 hardcoded runner names,
 * which was wrong in both directions.
 *
 * WHY THE SUBSTRING FORM HAD TO GO. `\b(?:vitest|jest|pytest|…)\b` asks "does this
 * text mention a runner", which is a different question from "does this line run
 * one". Measured against the golden corpus, it fired on `which pytest`,
 * `ls .venv/bin/pytest`, `cat vitest.config.mts`, `cat …/pytest.ini`, and a
 * heredoc writing `import { vi } from "vitest"` — every one of them reading or
 * writing ABOUT a test rather than running it. In the other direction it missed
 * `pnpm turbo test` (13 corpus lines) and `node --test` / `tsx --test` (22),
 * because those spell the invocation with a task name or a flag rather than a
 * runner's own name.
 *
 * Both failures are the same bug: the line was never parsed, so nothing knew
 * whether the runner name sat in HEAD position or in an argument. HEREDOC bodies
 * are dropped for the same reason and were found the same way — a corpus session
 * writes a PR body whose "Test plan" section quotes `npx tsx --test …`, and since
 * a body contains newlines and newline separates segments, that prose arrived as
 * its own command segment.
 *
 * EFFECT-BASED DETECTION WAS PREFERRED AND MEASURED AWAY. PLN-1490 asks for
 * harness-reported test results over command inference. `NormalizedToolUse` does
 * carry `output`/`isError`, so this was checked rather than assumed: of 91
 * test-shaped corpus lines only 41 carry output at all and only **16** carry
 * anything result-shaped, and those arrive inside a harness-specific envelope
 * (`Chunk ID: … Process exited with code 0 … Output:`) wrapping per-runner render
 * formats (vitest's `RUN v4.1.8`, pytest's progress dots). Parsing that would buy
 * 18% coverage in exchange for exactly the harness-specific vocabulary the
 * generality contract forbids. Effect-based evidence stays the right answer the
 * day a harness reports structured results; today it does not.
 *
 * THE GENERALITY CONTRACT (PLN-1490 level 3). Vocabulary here is limited to
 * PUBLISHED, cross-ecosystem tool contracts — the same standing as POSIX names in
 * `command-semantics.ts`. Defaults span JS/TS, Python, Go, Rust, JVM, Ruby, .NET,
 * Swift, Elixir and Dart. No organization's own scripts, wrappers or aliases
 * appear, and none are needed: bespoke wrappers are scanned past STRUCTURALLY by
 * the shared lexical layer.
 *
 * A TASK NAME IS NEVER UNIVERSAL — the same lesson `HEAD_WRITE_FLAGS` learned
 * about flags. `check` means "run the test suite" for `gradle` and "type-check
 * without building" for `cargo`; `verify` is a full test phase for `mvn` and
 * nothing in particular elsewhere. So only genuinely universal task names are
 * global ({@link UNIVERSAL_TEST_TASKS}); everything else is scoped to the head
 * that gives it that meaning ({@link HEAD_TEST_TASKS}).
 *
 * SAFETY DIRECTION. Unrecognized resolves to "not a test run". Validate is a
 * phase this evidence CLAIMS, so a false positive fabricates validation time out
 * of a lint or a file read — the failure the corpus actually exhibited. Missing a
 * novel runner merely leaves the command phase-neutral.
 */
import { isRecognizedCommandHead } from "./command-semantics.js";
import {
  bareTokensAfter,
  blankQuotedSpans,
  firstNonEnvIndex,
  headToken,
  isScriptInvocation,
  MAX_WRAPPER_TOKENS,
  packageBinaryName,
  segmentTokens,
  splitSegments,
  stripHeredocBodies,
} from "./command-tokens.js";

/**
 * Programs that ARE a test runner: invoking them at all is running tests. Their
 * subcommands (`vitest run`, `vitest watch`) do not change that.
 */
const TEST_RUNNER_HEADS = new Set([
  // JS/TS
  "vitest",
  "jest",
  "mocha",
  "ava",
  "jasmine",
  "karma",
  "tap",
  "uvu",
  "cypress",
  "testcafe",
  "nightwatch",
  // Python
  "pytest",
  "py.test",
  "nose2",
  "tox",
  "behave",
  // Ruby
  "rspec",
  "minitest",
  "cucumber",
  // PHP
  "phpunit",
  "pest",
  // C/C++
  "ctest",
  // Go
  "gotestsum",
  // Rust
  "nextest",
]);

/**
 * Heads whose FIRST bare token names the operation — a package script, a build
 * task, or a module to execute. The operation word decides, not the head.
 *
 * This is what makes the module generalize without listing invocations: any task
 * runner's `<runner> test` works, and a delegating form (`pnpm exec vitest`,
 * `python -m pytest`) re-resolves to whatever it delegates to.
 */
const TASK_RUNNER_HEADS = new Set([
  // JS/TS package managers and task runners
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "pnpx",
  "deno",
  "turbo",
  "nx",
  "lerna",
  "grunt",
  "gulp",
  // Generic task runners
  "make",
  "just",
  "task",
  "rake",
  "invoke",
  // Language toolchains
  "cargo",
  "go",
  "dotnet",
  "swift",
  "mix",
  "dart",
  "flutter",
  "composer",
  "bundle",
  "poetry",
  "uv",
  "pipenv",
  "hatch",
  "python",
  "python3",
  // JVM
  "mvn",
  "gradle",
  "sbt",
  "lein",
  "bazel",
  "stack",
]);

/**
 * Task names that mean "run the tests" in every ecosystem that has the concept.
 * Kept deliberately short — see the file header on why `check`/`verify` are not
 * here.
 */
const UNIVERSAL_TEST_TASKS = new Set(["test", "tests", "spec", "specs"]);

/**
 * Extra task names that mean tests only for a SPECIFIC head. `cargo check` is
 * pointedly absent: it type-checks without running anything, so a global `check`
 * rule would invent validation time on every Rust compile check.
 */
const HEAD_TEST_TASKS = new Map<string, ReadonlySet<string>>([
  ["gradle", new Set(["check"])],
  ["mvn", new Set(["verify"])],
  ["make", new Set(["check"])],
  ["rake", new Set(["spec"])],
  ["sbt", new Set(["testonly", "testquick"])],
  ["bazel", new Set(["coverage"])],
  ["flutter", new Set(["drive"])],
]);

/**
 * Words that mean "what follows is the real command": a package manager's script
 * or binary runner, and Python's module flag value. Scanning past these is what
 * resolves `pnpm exec vitest run` and `npm run test:unit`.
 */
const DELEGATING_TASK_WORDS = new Set([
  "run",
  "run-script",
  "exec",
  "dlx",
  "x",
]);

/**
 * The delegating words that execute a BINARY rather than name a script. After
 * one of these the operand is a program, so it must resolve by that program's
 * own semantics — `pnpm exec test` runs a binary called `test`, which is not the
 * `test` SCRIPT that `pnpm run test` names.
 */
const EXECUTING_DELEGATION_WORDS = new Set(["exec", "dlx", "x"]);

/**
 * Heads whose bare operand is a MODULE or SCRIPT to execute, not a task name.
 * `python test` runs a file called `test`; there is no task taxonomy to consult.
 * (`python -m pytest` still resolves — the module is read as a program below.)
 */
const MODULE_EXECUTOR_HEADS = new Set(["python", "python3"]);

/**
 * A package script whose NAME declares it runs tests: `test`, or a namespaced
 * `test:unit` / `test:node`. Anchored, so `test-utils` and `pretest` do not match
 * — a script that merely mentions tests is not one.
 */
const TEST_SCRIPT_NAME_RE = /^test(?::[\w.-]+)+$/;

/**
 * Runtimes whose BUILT-IN test runner is selected by a flag rather than a
 * subcommand — Node's `--test` (Node 18+), and the TypeScript loaders that
 * forward it. A published runtime contract, not a project convention.
 */
const RUNTIME_TEST_FLAG_HEADS = new Set(["node", "tsx", "ts-node", "swc-node"]);

/** The flag that selects a runtime's built-in test runner. */
const RUNTIME_TEST_FLAG = "--test";

/**
 * Runtime options that take a SEPARATED value which is NOT the program, so their
 * argument is not mistaken for the entry script. Published Node CLI contract,
 * shared by the TS loaders.
 */
const RUNTIME_VALUE_FLAGS = new Set([
  "--loader",
  "--experimental-loader",
  "--import",
  "--require",
  "-r",
  "--conditions",
  "-C",
  "--env-file",
]);

/**
 * Options whose value IS the program, and the bare `-` that names stdin as the
 * program. Each is an entry point spelled with a leading dash, so a check for
 * "first token not starting with `-`" walks straight past them — and everything
 * after an entry point belongs to the program, not the runtime.
 */
const RUNTIME_ENTRY_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);
const STDIN_ENTRY = "-";

/** The end-of-options separator: everything after it belongs to the script. */
const ARGUMENT_SEPARATOR = "--";

/**
 * Per-runner COLLECTION modes: the documented ways to ask a runner to enumerate
 * or compile the tests it WOULD run, without running any of them.
 *
 * A runner head otherwise means execution unconditionally, so `vitest list` and
 * `pytest --collect-only` minted `validate` time for work where nothing was
 * verified. Enumerating a suite is investigation — the same class of read as
 * `grep`ing for a test name — so a collection mode resolves to "not a test run"
 * and falls through to the effect reader, which is free to call it exploration.
 *
 * Each entry is that runner's own published flag or subcommand. Modes that run
 * tests AND report (`--verbose`, `--reporter`, `--dry-run` on runners where it
 * still executes) are deliberately absent: the test is "did it enumerate INSTEAD
 * of executing", not "did it print something".
 */
const RUNNER_COLLECTION_MODES: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  ["vitest", new Set(["list"])],
  ["jest", new Set(["--listtests"])],
  ["pytest", new Set(["--collect-only", "--co"])],
  ["py.test", new Set(["--collect-only", "--co"])],
  ["ctest", new Set(["-n", "--show-only"])],
  ["nextest", new Set(["list"])],
  ["gotestsum", new Set(["--list"])],
  ["mocha", new Set(["--dry-run"])],
  ["rspec", new Set(["--dry-run"])],
  ["cucumber", new Set(["--dry-run"])],
  ["behave", new Set(["--dry-run"])],
  ["phpunit", new Set(["--list-tests", "--list-suites", "--list-groups"])],
  ["pest", new Set(["--list-tests"])],
  ["tox", new Set(["--listenvs", "--listenvs-all"])],
  // Reached through the TASK path (`go test -list .`), not as a bare head.
  ["go", new Set(["-list"])],
  ["cargo", new Set(["--list"])],
  ["dotnet", new Set(["--list-tests", "-t"])],
]);

/**
 * Options that take a SEPARATED value, by task-runner head — the workspace and
 * directory selectors, whose values are plain words that shape alone cannot tell
 * from an operation (`pnpm --filter desktop run test`).
 *
 * Each entry is that tool's own published CLI contract, so this is a declared
 * arity rather than a vocabulary of project conventions. The attached spellings
 * (`--filter=desktop`) need no entry: they are a single token starting with `-`
 * and are skipped as flags already.
 */
const HEAD_VALUE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "pnpm",
    new Set(["--filter", "--filter-prod", "-C", "--dir", "-w", "--workspace"]),
  ],
  ["npm", new Set(["-w", "--workspace", "--prefix", "-C"])],
  ["yarn", new Set(["--cwd"])],
  ["bun", new Set(["--filter", "--cwd"])],
  ["turbo", new Set(["--filter", "--cwd"])],
  ["nx", new Set(["--project", "--projects"])],
]);

/**
 * How many delegating hops are followed (`pnpm exec vitest`, `python -m pytest`).
 * Two covers every published form; the bound exists so a pathological line cannot
 * recurse indefinitely.
 */
const MAX_DELEGATION_DEPTH = 2;

/**
 * Heads whose task names are PROJECT PATHS, so a task may be qualified by the
 * subproject it belongs to (`gradle :app:test`, `sbt core/test`). The terminal
 * segment is the task; the prefix selects where it runs.
 */
const PROJECT_QUALIFIED_TASK_HEADS = new Set(["gradle", "gradlew", "sbt"]);

/** The task itself, with any project qualifier stripped (`:app:test` → `test`). */
function terminalTaskName(head: string, task: string): string {
  if (!PROJECT_QUALIFIED_TASK_HEADS.has(head)) {
    return task;
  }
  const separator = Math.max(task.lastIndexOf(":"), task.lastIndexOf("/"));
  return separator < 0 ? task : task.slice(separator + 1);
}

/** True when `task` names a test operation for `head`. */
function isTestTask(head: string, task: string): boolean {
  const name = terminalTaskName(head, task);
  return (
    UNIVERSAL_TEST_TASKS.has(name) ||
    TEST_SCRIPT_NAME_RE.test(name) ||
    (HEAD_TEST_TASKS.get(head)?.has(name) ?? false)
  );
}

/** True when this head selects its runtime's built-in runner via `--test`. */
function usesRuntimeTestFlag(
  head: string,
  tokens: string[],
  headIndex: number
): boolean {
  if (!RUNTIME_TEST_FLAG_HEADS.has(head)) {
    return false;
  }
  for (let i = headIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    // Past a bare `--` the flags are the SCRIPT'S, not the runtime's, so a tool
    // that takes its own `--test` (`node ./cli.mjs -- --test`) is not selecting
    // Node's built-in runner.
    if (token === ARGUMENT_SEPARATOR) {
      return false;
    }
    if (token === RUNTIME_TEST_FLAG) {
      return true;
    }
    if (RUNTIME_VALUE_FLAGS.has(token)) {
      i++;
      continue;
    }
    // The ENTRY POINT ends the runtime's own options: everything after the
    // program belongs to it. Without this, `node script.mjs --test` — where
    // `--test` is the script's own flag — fabricated a built-in Node test run.
    //
    // Two of the three entry spellings start with a dash, so a bare
    // "doesn't look like a flag" test walks straight past them: `-` names stdin
    // as the program (`cat s.mjs | node - --test`), and `-e`/`-p` carry the
    // program as their value (`node -e "…" --test`).
    if (
      token === STDIN_ENTRY ||
      RUNTIME_ENTRY_FLAGS.has(token) ||
      !token.startsWith("-")
    ) {
      return false;
    }
  }
  return false;
}

/** True when this runner was asked to ENUMERATE its tests rather than run them. */
function runsInCollectionMode(
  head: string,
  tokens: string[],
  headIndex: number
): boolean {
  const modes = RUNNER_COLLECTION_MODES.get(head);
  if (modes === undefined) {
    return false;
  }
  for (let i = headIndex + 1; i < tokens.length; i++) {
    // Past a bare `--` the arguments belong to the tests, not the runner.
    if (tokens[i] === ARGUMENT_SEPARATOR) {
      return false;
    }
    // Split a `--flag=value` so the mode is recognized in either spelling.
    const flag = tokens[i].toLowerCase().split("=")[0];
    if (modes.has(flag)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the command at `headIndex` runs tests.
 *
 * Returns `null` for "unrecognized — keep scanning", which is what lets a bespoke
 * wrapper (`<sandbox proxy> pnpm test`) resolve without being named.
 */
function headRunsTests(
  tokens: string[],
  headIndex: number,
  depth: number
): boolean | null {
  const token = tokens[headIndex];
  // A dependency's installed executable (`.venv/bin/pytest`,
  // `node_modules/.bin/vitest`) is that program under the packaging tool's own
  // contract, so it resolves by binary name where a bespoke path never would.
  // The basename then feeds EVERY head test below, not just the runner set: a
  // package-installed runtime or task runner is no less itself for having been
  // spelled by path, and matching only direct runners made
  // `.venv/bin/python -m pytest` and `node_modules/.bin/tsx --test` fall through
  // to the wrapper scan and stop there as script invocations.
  const head = packageBinaryName(token) ?? headToken(token);
  if (TEST_RUNNER_HEADS.has(head)) {
    // A runner asked to ENUMERATE its tests ran none of them. `false`, not
    // `null`: the runner is recognized and has answered, so the wrapper scan
    // must not walk past it looking for something else to blame.
    return !runsInCollectionMode(head, tokens, headIndex);
  }
  if (usesRuntimeTestFlag(head, tokens, headIndex)) {
    return true;
  }
  if (!TASK_RUNNER_HEADS.has(head)) {
    return null;
  }
  // A task runner always DECIDES here rather than falling through to the wrapper
  // scan: its operation word is the whole signal, so a later positional argument
  // must never be read as one (`pnpm add test-helpers` is not a test run).
  return delegatedVerdict(tokens, headIndex, head, depth);
}

/** The verdict for a task runner: its operation word, or whatever it delegates to. */
function delegatedVerdict(
  tokens: string[],
  headIndex: number,
  head: string,
  depth: number
): boolean {
  const bare = bareTokensAfter(
    tokens,
    headIndex,
    MAX_DELEGATION_DEPTH + 1,
    HEAD_VALUE_FLAGS.get(head)
  );
  let position = 0;
  let executesBinary = false;
  while (
    position < bare.length &&
    DELEGATING_TASK_WORDS.has(bare[position].token)
  ) {
    executesBinary =
      executesBinary || EXECUTING_DELEGATION_WORDS.has(bare[position].token);
    position++;
  }
  const operation = bare[position];
  if (!operation) {
    return false;
  }
  // The task taxonomy applies only where the operand really names a TASK. After
  // an executing delegation, or under a head that runs a module by name, the
  // operand is a program and must resolve as one — otherwise `pnpm exec test`
  // and `python test` counted as test runs purely because a binary was named
  // `test`.
  const namesTask = !(executesBinary || MODULE_EXECUTOR_HEADS.has(head));
  if (namesTask && isTestTask(head, operation.token)) {
    // Its own test task, but possibly in a collection mode (`go test -list .`).
    return !runsInCollectionMode(head, tokens, operation.index);
  }
  if (depth >= MAX_DELEGATION_DEPTH) {
    return false;
  }
  // Not this runner's own task name, so it is delegating to another program:
  // `pnpm turbo test`, `pnpm exec vitest run`, `python3 -m pytest`.
  return headRunsTests(tokens, operation.index, depth + 1) === true;
}

/** Whether one already-quote-blanked segment runs tests. */
function segmentRunsTests(segment: string): boolean {
  const tokens = segmentTokens(segment);
  const start = firstNonEnvIndex(tokens);
  let examined = 0;
  for (let i = start; i < tokens.length && examined < MAX_WRAPPER_TOKENS; i++) {
    if (tokens[i].startsWith("-")) {
      continue;
    }
    examined++;
    const verdict = headRunsTests(tokens, i, 0);
    if (verdict !== null) {
      return verdict;
    }
    // Unrecognized here, but possibly a command the EFFECT vocabulary knows. Such
    // a head consumes its arguments instead of executing them, so scanning past it
    // would resolve an argument as an invocation (`ls .venv/bin/pytest`).
    if (isRecognizedCommandHead(tokens[i])) {
      return false;
    }
    // Genuinely unrecognized. Walking past it treats it as a wrapper; refuse when
    // it names a script, whose argument we cannot assume was handed to a wrapper.
    if (isScriptInvocation(tokens[i])) {
      return false;
    }
  }
  return false;
}

/**
 * True when a shell command line runs a test suite. Pure and deterministic.
 *
 * Any segment running tests makes the line a test run — `pnpm build && pnpm test`
 * genuinely ran the suite. Quoted content is blanked first, so a runner named
 * inside a search pattern (`rg "tsx --test"`) is text being looked for.
 */
export function isTestInvocation(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  const masked = blankQuotedSpans(stripHeredocBodies(trimmed));
  for (const segment of splitSegments(masked)) {
    if (segment.trim() && segmentRunsTests(segment)) {
      return true;
    }
  }
  return false;
}
