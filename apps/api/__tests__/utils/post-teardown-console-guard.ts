import path from "node:path";
import { format } from "node:util";
import {
  escapeAnnotationData,
  escapeAnnotationProperty,
} from "@repo/vitest-config";
import { afterAll } from "vitest";

/**
 * ISS-10749 — keep a console write that arrives after a test file is done off
 * Vitest's RPC channel.
 *
 * Vitest replaces `globalThis.console` with one whose writes are buffered and
 * flushed to the main process over `rpc.onUserConsoleLog`. A write that lands
 * once the worker has started closing that channel fails the whole run with
 * `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`
 * — an unhandled error, not a test failure, so the suite reports fully green
 * and the required `test` check ejects whatever PR was in the merge queue.
 *
 * `apps/api` produces those writes structurally: a route's response-path
 * `waitUntil(...)` seam runs real work against the unit lane's placeholder
 * `DATABASE_URL`, fails, and logs long after the test body resolved. ISS-8643
 * and this ticket each fixed one file by mocking the seam it happened to reach;
 * the class returned because a seam added to a SHARED side-effect emitter makes
 * every existing test of every route that calls it leak without that test
 * changing.
 *
 * `process.stderr.write` is not intercepted, so re-routing the late write there
 * prints it in full — with the file that owns it named — while making the RPC
 * race unreachable. Nothing is suppressed and no unhandled rejection is
 * swallowed: an error that would have surfaced still surfaces, and ISS-9661's
 * `unhandledErrorReporter` still reports every unhandled error in the run.
 */

/**
 * Every `Console` method that can reach the intercepted stream. Vitest builds
 * its console with `new Console({ stdout, stderr })`, so the interception is on
 * the STREAMS, not on a list of method names: `dir`, `table`, `assert` and the
 * timing/counting methods land on `onUserConsoleLog` exactly like `log` does,
 * and a guard that covers only the familiar six leaves the race reachable
 * through the rest. `clear`, `profile`, `profileEnd` and `timeStamp` are the
 * ones left out — none of them writes to a non-TTY stream.
 */
const GUARDED_METHODS = [
  "assert",
  "count",
  "countReset",
  "debug",
  "dir",
  "dirxml",
  "error",
  "group",
  "groupCollapsed",
  "groupEnd",
  "info",
  "log",
  "table",
  "time",
  "timeEnd",
  "timeLog",
  "trace",
  "warn",
] as const;

type GuardedMethod = (typeof GUARDED_METHODS)[number];

type ConsoleLike = Record<GuardedMethod, (...args: unknown[]) => void>;

export type PostTeardownWrite = {
  method: GuardedMethod;
  text: string;
  stack?: string;
};

/**
 * Per-worker, because `globalThis.console` is replaced once per worker while
 * `setupFiles` runs once per FILE. Wrapping on every setup would stack a
 * wrapper per file, and a later file's ordinary log would fall through to an
 * earlier file's already-finished wrapper and be diverted under that file's
 * name. Vitest's default `isolate: true` gives this package one file per
 * worker, so that stacking is unreachable today — the state is shared so the
 * guard does not become wrong the day a lane turns isolation off for speed.
 */
type GuardState = {
  finished: boolean;
  testPath: string;
};

type GuardHost = {
  closedloopPostTeardownConsoleGuard?: GuardState;
};

const BANNER =
  "POST-TEARDOWN CONSOLE WRITE (ISS-10749): a test file logged after it finished.";
const EXPLANATION =
  'The write was re-routed to stderr so it cannot fail the run as `Closing rpc while "onUserConsoleLog" was pending`. It still means work the file scheduled outlived it — usually an unmocked `waitUntil(...)` seam on a route the file drives. Mock that seam in the file named below.';
const ANNOTATION_TITLE =
  "Post-teardown console write (green suite, leaked work)";
const UNKNOWN_FILE = "unknown (Vitest reported no test path)";

/**
 * Swaps every intercepted console method for one that diverts a late write.
 * Separated from {@link installPostTeardownConsoleGuard} so the decision can be
 * executed against a synthetic console and a synthetic teardown state.
 */
export function guardPostTeardownConsole(options: {
  target: ConsoleLike;
  hasFinished: () => boolean;
  divert: (write: PostTeardownWrite) => void;
}): void {
  const { target, hasFinished, divert } = options;
  for (const method of GUARDED_METHODS) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => {
      if (hasFinished()) {
        // Without this the report names the file and nothing else, and the
        // reader has to redo the ISS-10749 investigation to find the seam that
        // wrote. Frames: the synthetic `Error` header, then this wrapper; the
        // writer is what follows them.
        const stack = new Error("post-teardown console write").stack
          ?.split("\n")
          .slice(2)
          .join("\n");
        divert({ method, text: format(...args), stack });
        return;
      }
      original(...args);
    };
  }
}

/**
 * The lines one diverted write prints, as data, so a test grades the decision
 * rather than the plumbing.
 */
export function postTeardownWriteReport(
  testPath: string,
  write: PostTeardownWrite
): string[] {
  const shown = repoRelative(testPath);
  const lines = [
    `\n${BANNER}\n${EXPLANATION}`,
    `  originating test file: ${shown}`,
    `  console.${write.method}: ${write.text}`,
  ];
  if (write.stack) {
    lines.push(`  written from:\n${write.stack}`);
  }
  if (process.env.GITHUB_ACTIONS === "true" && shown !== UNKNOWN_FILE) {
    lines.push(
      `::error file=${escapeAnnotationProperty(shown)},title=${escapeAnnotationProperty(ANNOTATION_TITLE)}::${escapeAnnotationData(`${BANNER} console.${write.method}: ${write.text}`)}`
    );
  }
  return lines;
}

/**
 * ONE write, not one per line: in the threads pool a worker's `process.stderr`
 * posts its first chunk to the parent and holds the rest until that chunk is
 * acked, and the pool terminates the worker as soon as the file ends. A write
 * per line lets the banner make it out while the file name, the originating
 * stack and the annotation are dropped.
 */
export function writePostTeardownReport(
  stderr: { write: (chunk: string) => void },
  testPath: string,
  write: PostTeardownWrite
): void {
  stderr.write(`${postTeardownWriteReport(testPath, write).join("\n")}\n`);
}

/**
 * Installs the guard for the file currently being set up. The `afterAll` is
 * registered from a setup file, which makes it the first hook registered and —
 * Vitest runs `afterAll` in reverse registration order — the last to run, so
 * anything writing after it is work the file left behind.
 */
export function installPostTeardownConsoleGuard(): void {
  const state = guardWorkerConsole();
  state.finished = false;
  state.testPath = currentTestPath();
  afterAll(() => {
    state.finished = true;
  });
}

/**
 * Read by the wiring test: an installed guard is the only thing that proves the
 * setup file CALLS the installer rather than merely importing it.
 */
export function isPostTeardownConsoleGuardInstalled(): boolean {
  return (
    (globalThis as GuardHost).closedloopPostTeardownConsoleGuard !== undefined
  );
}

/**
 * Read once while the file is being set up, not when a late write arrives: by
 * then the worker may already be loading the NEXT file, and reporting that one
 * sends the reader after a suite that did nothing wrong.
 *
 * Vitest's worker state is what `expect.getState().testPath` reads, and it is
 * read here directly because `expect` outside a test body fails Biome's
 * `noMisplacedAssertion` and a hook parameter fails `noDoneCallback`. A Vitest
 * upgrade that renames it costs the banner its file name and nothing else — the
 * divert, which is what keeps the write off the RPC, does not depend on it.
 */
function currentTestPath(): string {
  const worker = (globalThis as { __vitest_worker__?: { filepath?: string } })
    .__vitest_worker__;
  return worker?.filepath ?? UNKNOWN_FILE;
}

/**
 * A GitHub Actions annotation path must be relative to the repo root, which
 * `GITHUB_WORKSPACE` is on a runner. Off a runner nothing is annotated, so the
 * absolute path is the more useful thing to print.
 */
function repoRelative(testPath: string): string {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) {
    return testPath;
  }
  const relative = path.relative(workspace, testPath);
  return relative.startsWith("..") ? testPath : relative;
}

function guardWorkerConsole(): GuardState {
  const host = globalThis as GuardHost;
  const existing = host.closedloopPostTeardownConsoleGuard;
  if (existing) {
    return existing;
  }
  const state: GuardState = { finished: false, testPath: UNKNOWN_FILE };
  host.closedloopPostTeardownConsoleGuard = state;
  guardPostTeardownConsole({
    target: globalThis.console as unknown as ConsoleLike,
    hasFinished: () => state.finished,
    divert: (write) =>
      writePostTeardownReport(process.stderr, state.testPath, write),
  });
  return state;
}
