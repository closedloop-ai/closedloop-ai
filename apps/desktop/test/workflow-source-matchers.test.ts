/**
 * ISS-6410 — the two decisions `run-node-tests-job-cap.test.ts` rests on, on
 * synthetic inputs.
 *
 * Both were false-greens in the guard itself (wongk's review, in a PR about
 * false-greens): the step lookup credited a lane with running the suite when
 * only the TEXT of the command survived, and the filter check proved a literal
 * was listed rather than that a real changed path triggers the lane. Neither is
 * exercised hard enough by the real workflows — they declare one shape each —
 * so the defeat space is pinned here.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  pathTriggersFilter,
  runsCommand,
} from "./helpers/workflow-source-matchers.js";

const SUITE_COMMAND = "pnpm --filter desktop run test";

describe("a step is credited with running the suite only when it executes it", () => {
  const NOT_EXECUTED = [
    ["a commented-out invocation", `# ${SUITE_COMMAND}`],
    ["an indented commented-out invocation", `    #  ${SUITE_COMMAND}`],
    [
      "an invocation commented out after a real command",
      `pnpm install # ${SUITE_COMMAND}`,
    ],
    ["an echoed invocation", `echo ${SUITE_COMMAND}`],
    ["a quoted invocation", `echo "${SUITE_COMMAND}"`],
    [
      "a heredoc body",
      `cat <<'EOF' > run.sh\n${SUITE_COMMAND}\nEOF\necho wrote it`,
    ],
    [
      "an indent-stripped heredoc body",
      `cat <<-EOF > run.sh\n\t${SUITE_COMMAND}\n\tEOF`,
    ],
    ["a narrower slice of the suite", `${SUITE_COMMAND}:node`],
    ["a same-prefixed sibling script", `${SUITE_COMMAND}-renderer`],
  ] as const;

  for (const [label, run] of NOT_EXECUTED) {
    test(`${label} does not count`, () => {
      assert.equal(runsCommand(run, SUITE_COMMAND), false, run);
    });
  }

  const EXECUTED = [
    ["a bare invocation", SUITE_COMMAND],
    [
      "the piped form desktop-test-validation.yml uses",
      `set -o pipefail\n${SUITE_COMMAND} 2>&1 | tee apps/desktop/desktop-suite.log`,
    ],
    ["a chained invocation", `pnpm install && ${SUITE_COMMAND}`],
    ["a redirected invocation", `${SUITE_COMMAND} > suite.log`],
    ["an env-prefixed invocation", `CI=1 FORCE_COLOR=0 ${SUITE_COMMAND}`],
    [
      "an invocation below a comment that mentions it",
      `# runs ${SUITE_COMMAND} twice on retry\n${SUITE_COMMAND}`,
    ],
    [
      "an invocation after a heredoc closes",
      `cat <<'EOF' > note.txt\nnothing\nEOF\n${SUITE_COMMAND}`,
    ],
  ] as const;

  for (const [label, run] of EXECUTED) {
    test(`${label} counts`, () => {
      assert.equal(runsCommand(run, SUITE_COMMAND), true, run);
    });
  }
});

describe("a path filter is decided, not searched for a literal", () => {
  test("a `!` negation excludes a path a positive rule matched", () => {
    const patterns = [".github/workflows/desktop-release.yml"];
    assert.equal(
      pathTriggersFilter(patterns, ".github/workflows/desktop-release.yml"),
      true
    );
    assert.equal(
      pathTriggersFilter(
        [...patterns, "!.github/workflows/desktop-*.yml"],
        ".github/workflows/desktop-release.yml"
      ),
      false,
      "the literal is still listed, so only the decision can see the exclusion"
    );
  });

  test("`**` spans separators and `*` does not", () => {
    // `.github/AGENTS.md`: nested paths are the common miss.
    const nested = "apps/desktop/test/helpers/workflow-source-matchers.ts";
    assert.equal(pathTriggersFilter(["apps/**/*.ts"], nested), true);
    assert.equal(pathTriggersFilter(["apps/*/*.ts"], nested), false);
  });

  test("a path no rule matches does not trigger", () => {
    assert.equal(
      pathTriggersFilter(["apps/desktop/**"], "apps/web/app/page.tsx"),
      false
    );
  });

  test("a glob's regex metacharacters stay literal", () => {
    // `.` must not match any character, or `pnpm-lock.yaml` would be triggered
    // by `pnpm-lockXyaml`.
    assert.equal(
      pathTriggersFilter(["pnpm-lock.yaml"], "pnpm-lock.yaml"),
      true
    );
    assert.equal(
      pathTriggersFilter(["pnpm-lock.yaml"], "pnpm-lockXyaml"),
      false
    );
  });
});
