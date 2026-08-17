import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  PullRequestLabelLimit,
  TAG_COLOR_LABEL_HEX,
  TAG_LABEL_DESCRIPTION,
} from "@repo/api/src/types/pull-request-label";
import { TagColor } from "@repo/api/src/types/tag";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  parseRequestedLabels,
  registerGitPrCreateRoute,
} from "../src/server/operations/git-pr-create.js";
import { configureBinaryPathsResolver } from "../src/server/operations/symphony-loop.js";

/**
 * ISS-4664: the gateway PR-creation route carries the implementing ISS's tags
 * as an OPTIONAL `labels` array. These tests drive the real route through a
 * fake `gh` that records its argv, so we assert the actual create-if-missing +
 * additive-apply calls — and that an older client (no `labels`) makes none.
 */

const INFRA_LABEL = {
  name: "infra",
  color: TAG_COLOR_LABEL_HEX[TagColor.Blue],
  description: TAG_LABEL_DESCRIPTION,
};
const DOCS_LABEL = {
  name: "docs",
  color: TAG_COLOR_LABEL_HEX[TagColor.Green],
  description: TAG_LABEL_DESCRIPTION,
};
// A single tag whose name legitimately contains a comma. `gh pr edit
// --add-label` would tear this into two labels; the REST array path must keep
// it whole.
const PERF_P1_LABEL = {
  name: "perf, p1",
  color: TAG_COLOR_LABEL_HEX[TagColor.Red],
  description: TAG_LABEL_DESCRIPTION,
};

const tempDirs: string[] = [];

afterEach(async () => {
  configureBinaryPathsResolver(null);
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("parseRequestedLabels (IPC payload shape)", () => {
  test("accepts the new client's label array", () => {
    assert.deepEqual(parseRequestedLabels([INFRA_LABEL]).labels, [INFRA_LABEL]);
  });

  test("treats an old client that omits labels as requesting none", () => {
    assert.deepEqual(parseRequestedLabels(undefined).labels, []);
    assert.deepEqual(parseRequestedLabels(null).labels, []);
  });

  test("degrades gracefully instead of rejecting an unknown label shape", () => {
    assert.deepEqual(parseRequestedLabels("infra,docs").labels, []);
    assert.deepEqual(parseRequestedLabels([{ name: "infra" }]).labels, []);
    assert.deepEqual(
      parseRequestedLabels([{ name: "infra", color: "#3b82f6" }]).labels,
      []
    );
  });

  // ISS-4762: one malformed element used to reject the WHOLE array, so a
  // newer client with a single bad entry lost every good label with it.
  test("keeps the valid labels when one element is malformed", () => {
    assert.deepEqual(
      parseRequestedLabels([
        INFRA_LABEL,
        { name: "bad", color: "nope" },
        DOCS_LABEL,
      ]).labels,
      [INFRA_LABEL, DOCS_LABEL]
    );
  });

  // ISS-4764: skipping keeps PR creation fail-open, but a silent skip made a
  // payload whose every element was malformed look exactly like a payload that
  // asked for no labels at all. The count is what the gateway monitor reports.
  test("counts the malformed elements it skipped", () => {
    const parsed = parseRequestedLabels([
      INFRA_LABEL,
      { name: "bad", color: "nope" },
      { name: "worse" },
    ]);

    assert.equal(parsed.rejectedCount, 2);
    assert.deepEqual(parsed.labels, [INFRA_LABEL]);
  });

  test("counts nothing rejected for a well-formed payload", () => {
    assert.equal(parseRequestedLabels([INFRA_LABEL]).rejectedCount, 0);
    assert.equal(parseRequestedLabels(undefined).rejectedCount, 0);
  });

  // ISS-4762: over the ceiling the payload is CLAMPED and the excess named —
  // the old `.max()` list validator turned "too many" into "none at all".
  test("clamps an over-ceiling payload and names what it dropped", () => {
    const overflow = 2;
    const payload = Array.from(
      { length: PullRequestLabelLimit.MaxLabelsPerPullRequest + overflow },
      (_unused, index) => ({
        name: `tag-${String(index).padStart(3, "0")}`,
        color: TAG_COLOR_LABEL_HEX[TagColor.Teal],
        description: TAG_LABEL_DESCRIPTION,
      })
    );

    const parsed = parseRequestedLabels(payload);

    assert.equal(
      parsed.labels.length,
      PullRequestLabelLimit.MaxLabelsPerPullRequest
    );
    assert.equal(parsed.droppedTagNames.length, overflow);
  });
});

describe("POST /api/gateway/git/pr label propagation", () => {
  test("creates missing labels and adds every tag label to the new PR", async () => {
    const repoDir = await makeGitRepoFixture();
    const { ghBin, argvLog } = await makeGhFixture({
      existingLabels: ["infra"],
    });
    const dispatcher = makeDispatcher(repoDir, ghBin);

    const response = await dispatchCreate(dispatcher, {
      repoPath: repoDir,
      title: "ISS-4664: propagate labels",
      labels: [INFRA_LABEL, DOCS_LABEL],
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.appliedLabels, ["infra", "docs"]);
    assert.equal(response.body.labelsApplied, true);

    const argv = await readArgvLog(argvLog);
    // `infra` already exists in the repo, so only `docs` is created…
    assert.equal(
      argv.some(
        (line) =>
          line.includes("repos/acme/widgets/labels") &&
          line.includes("name=docs") &&
          line.includes(`color=${DOCS_LABEL.color}`)
      ),
      true
    );
    assert.equal(
      argv.some(
        (line) =>
          line.includes("repos/acme/widgets/labels") &&
          line.includes("name=infra")
      ),
      false
    );
    // …and both are applied through the ADDITIVE issues/{n}/labels REST call
    // (never `gh pr edit --add-label`, which comma-splits), never a replacing
    // write that could drop a manually-added label.
    assert.equal(
      argv.some(
        (line) =>
          line.includes(
            "api --method POST repos/acme/widgets/issues/7/labels"
          ) &&
          line.includes("labels[]=infra") &&
          line.includes("labels[]=docs")
      ),
      true
    );
    // Regression: never fall back to the comma-splitting `pr edit --add-label`.
    assert.equal(
      argv.some((line) => line.includes("--add-label")),
      false
    );
  });

  test("keeps a comma-bearing label name whole (no --add-label comma split)", async () => {
    const repoDir = await makeGitRepoFixture();
    const { ghBin, argvLog } = await makeGhFixture({ existingLabels: [] });
    const dispatcher = makeDispatcher(repoDir, ghBin);

    const response = await dispatchCreate(dispatcher, {
      repoPath: repoDir,
      title: "ISS-4664: comma label",
      labels: [PERF_P1_LABEL],
    });

    assert.equal(response.statusCode, 200);
    // The single tag is reported as ONE applied label, not split into two.
    assert.deepEqual(response.body.appliedLabels, ["perf, p1"]);
    assert.equal(response.body.labelsApplied, true);

    const argv = await readArgvLog(argvLog);
    // The literal comma-bearing name survives as one `labels[]=` value, and the
    // repository label was created under that same exact name.
    assert.equal(
      argv.some(
        (line) =>
          line.includes(
            "api --method POST repos/acme/widgets/issues/7/labels"
          ) && line.includes("labels[]=perf, p1")
      ),
      true
    );
    assert.equal(
      argv.some(
        (line) =>
          line.includes("repos/acme/widgets/labels") &&
          line.includes("name=perf, p1")
      ),
      true
    );
    // No comma-splitting `pr edit --add-label` path is taken at all.
    assert.equal(
      argv.some((line) => line.includes("--add-label")),
      false
    );
  });

  test("makes no label calls when an older client omits labels", async () => {
    const repoDir = await makeGitRepoFixture();
    const { ghBin, argvLog } = await makeGhFixture({ existingLabels: [] });
    const dispatcher = makeDispatcher(repoDir, ghBin);

    const response = await dispatchCreate(dispatcher, {
      repoPath: repoDir,
      title: "ISS-4664: no labels",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.number, 7);
    assert.equal("appliedLabels" in response.body, false);
    assert.equal("labelsApplied" in response.body, false);

    const argv = await readArgvLog(argvLog);
    assert.equal(
      argv.some(
        (line) =>
          line.includes("repos/acme/widgets/labels") ||
          line.includes("--add-label")
      ),
      false
    );
  });

  test("still reports the created PR when labelling fails", async () => {
    const repoDir = await makeGitRepoFixture();
    const { ghBin } = await makeGhFixture({
      existingLabels: [],
      failLabelWrites: true,
    });
    const dispatcher = makeDispatcher(repoDir, ghBin);

    const response = await dispatchCreate(dispatcher, {
      repoPath: repoDir,
      title: "ISS-4664: labelling fails",
      labels: [INFRA_LABEL],
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.number, 7);
    assert.deepEqual(response.body.appliedLabels, []);
    assert.equal(response.body.labelsApplied, false);
    assert.deepEqual(response.body.unappliedLabels, [INFRA_LABEL.name]);
  });

  // ISS-4764: a set larger than one provider write is applied in successive
  // batches. A failure on the second batch used to be reported as a flat
  // success by the first, and the names that never landed were absent from the
  // response entirely, so no caller could tell partial from full.
  test("reports a partial multi-batch apply as unapplied, not applied", async () => {
    const overflow = 1;
    const labelCount = PullRequestLabelLimit.ApplyBatchSize + overflow;
    const labels = Array.from({ length: labelCount }, (_unused, index) => ({
      name: `tag-${String(index).padStart(3, "0")}`,
      color: TAG_COLOR_LABEL_HEX[TagColor.Teal],
      description: TAG_LABEL_DESCRIPTION,
    }));
    const repoDir = await makeGitRepoFixture();
    const { ghBin } = await makeGhFixture({
      existingLabels: labels.map((label) => label.name),
      failLabelAddsAfterBatch: 1,
    });
    const dispatcher = makeDispatcher(repoDir, ghBin);

    const response = await dispatchCreate(dispatcher, {
      repoPath: repoDir,
      title: "ISS-4764: partial batch",
      labels,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(
      (response.body.appliedLabels as string[]).length,
      PullRequestLabelLimit.ApplyBatchSize
    );
    // The first batch landed, so the old boolean said "applied".
    assert.equal(response.body.labelsApplied, false);
    assert.deepEqual(response.body.unappliedLabels, [
      labels.at(-1)?.name ?? "",
    ]);
  });

  // Additive and optional: the field must stay ABSENT (never null) on the happy
  // path, so an older client sees byte-identical behavior.
  test("omits unappliedLabels entirely when every label lands", async () => {
    const repoDir = await makeGitRepoFixture();
    const { ghBin } = await makeGhFixture({ existingLabels: ["infra"] });
    const dispatcher = makeDispatcher(repoDir, ghBin);

    const response = await dispatchCreate(dispatcher, {
      repoPath: repoDir,
      title: "ISS-4764: full apply",
      labels: [INFRA_LABEL, DOCS_LABEL],
    });

    assert.equal(response.body.labelsApplied, true);
    assert.equal("unappliedLabels" in response.body, false);
  });
});

async function makeGitRepoFixture(): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), "git-pr-create-"));
  tempDirs.push(repoDir);
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "feat/labels"], {
    cwd: repoDir,
    stdio: "ignore",
  });
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:acme/widgets.git"],
    { cwd: repoDir, stdio: "ignore" }
  );
  // `git push` must succeed without a network: point `origin` at a local bare
  // repo instead, which the route's `push -u origin <branch>` can satisfy.
  const remoteDir = await mkdtemp(path.join(os.tmpdir(), "git-pr-remote-"));
  tempDirs.push(remoteDir);
  execFileSync("git", ["init", "--bare"], { cwd: remoteDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoDir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: repoDir,
    stdio: "ignore",
  });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
    cwd: repoDir,
    stdio: "ignore",
  });
  execFileSync("git", ["remote", "set-url", "--push", "origin", remoteDir], {
    cwd: repoDir,
    stdio: "ignore",
  });
  return repoDir;
}

async function makeGhFixture(options: {
  existingLabels: string[];
  failLabelWrites?: boolean;
  /**
   * Fail every `issues/{n}/labels` add call after this many succeeded, so a
   * multi-batch apply can be driven into a genuinely PARTIAL outcome.
   */
  failLabelAddsAfterBatch?: number;
}): Promise<{ ghBin: string; argvLog: string }> {
  const binDir = await mkdtemp(path.join(os.tmpdir(), "git-pr-create-bin-"));
  tempDirs.push(binDir);
  const ghBin = path.join(binDir, "gh");
  const argvLog = path.join(binDir, "argv.log");
  const batchCounter = path.join(binDir, "add-batches.count");
  const existing = options.existingLabels.join("\n");
  const labelWriteExit = options.failLabelWrites ? "1" : "0";
  const failAfter = options.failLabelAddsAfterBatch ?? 0;
  await writeFile(
    ghBin,
    `#!/bin/sh
echo "$@" >> ${JSON.stringify(argvLog)}
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo "https://github.com/acme/widgets/pull/7"
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--method" ]; then
  case "$4" in
    *issues/*/labels)
      if [ ${failAfter} -gt 0 ]; then
        count=$(cat ${JSON.stringify(batchCounter)} 2>/dev/null || echo 0)
        count=$((count + 1))
        echo "$count" > ${JSON.stringify(batchCounter)}
        if [ "$count" -gt ${failAfter} ]; then
          exit 1
        fi
      fi
      ;;
  esac
  exit ${labelWriteExit}
fi
if [ "$1" = "api" ]; then
  printf '%s\\n' ${JSON.stringify(existing)}
  exit 0
fi
exit 0
`,
    { mode: 0o755 }
  );
  return { ghBin, argvLog };
}

function makeDispatcher(repoDir: string, ghBin: string): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerGitPrCreateRoute(dispatcher, () => [repoDir]);
  configureBinaryPathsResolver(() => ({ gh: ghBin }));
  return dispatcher;
}

async function readArgvLog(argvLog: string): Promise<string[]> {
  try {
    const contents = await readFile(argvLog, "utf8");
    return contents.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function dispatchCreate(
  dispatcher: OperationDispatcher,
  payload: Record<string, unknown>
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  const chunks: string[] = [];
  const response = {
    statusCode: 200,
    setHeader: () => undefined,
    end: (chunk?: string | Buffer) => {
      if (chunk) {
        chunks.push(String(chunk));
      }
    },
  } as unknown as ServerResponse;

  const handled = await dispatcher.dispatch({
    method: "POST",
    pathname: "/api/gateway/git/pr",
    params: {},
    query: new URLSearchParams(),
    rawBody,
    body: rawBody.toString("utf8"),
    request: {} as IncomingMessage,
    response,
  });
  if (!handled) {
    throw new Error("Expected PR create route to be handled");
  }
  return {
    statusCode: response.statusCode,
    body: JSON.parse(chunks.join("")) as Record<string, unknown>,
  };
}
