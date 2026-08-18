import {
  batchPullRequestLabels,
  type PullRequestLabelMapping,
  type PullRequestLabelSpec,
  parsePullRequestLabelSpecList,
  pullRequestLabelsToAdd,
} from "@repo/api/src/types/pull-request-label";
import { z } from "zod";
import { gatewayLog } from "../../main/logging/gateway-logger.js";
import type {
  OperationDispatcher,
  OperationRequestContext,
} from "../operation-dispatcher.js";
import { DirectoryNotAllowedError } from "../security.js";
import { resolveBinaryFromLoginShell } from "../shell-path.js";
import {
  asString,
  getRepoSlug,
  parseGhError,
  parsePrNumber,
  run,
  runRead,
} from "./git-pr-exec.js";
import { parseBody } from "./parse-body.js";
import { json } from "./response-utils.js";
import { getOverrideBinaryPaths, getResolvedGitPath } from "./symphony-loop.js";
import { assertRepoAllowed } from "./symphony-utils.js";

/**
 * `POST /api/gateway/git/pr` — create a pull request for the checkout's current
 * branch through the local `gh` CLI.
 *
 * ISS-4664 extends the request body with an OPTIONAL `labels` array carrying
 * the implementing ISS's tags (name + GitHub hex colour). The field is purely
 * additive: an older renderer or relay client that omits it gets byte-identical
 * behavior to before, and an unparseable value is ignored rather than rejected
 * so a newer client's shape drift can never block PR creation. Labelling itself
 * is best-effort and runs AFTER the PR exists — a labelling failure is reported
 * in the response, never as a failed PR creation.
 */
export function registerGitPrCreateRoute(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[]
): void {
  dispatcher.register("POST", "/api/gateway/git/pr", async (context) => {
    const request = resolveCreateRequest(context, getAllowedDirectories);
    if (!request.ok) {
      json(context, request.status, { error: request.error });
      return;
    }

    const ghBin = (
      await resolveBinaryFromLoginShell("gh", getOverrideBinaryPaths()?.gh)
    ).path;

    try {
      const response = await createPullRequest(request.value, ghBin);
      json(context, 200, response);
    } catch (error) {
      const existing = await viewExistingPullRequest(
        request.value,
        ghBin,
        error
      );
      if (existing) {
        json(context, 200, existing);
        return;
      }
      json(context, 500, { error: parseGhError(error) });
    }
  });
}

type CreateRequestContext = {
  cwd: string;
  title: string;
  fullBody: string;
  labels: PullRequestLabelSpec[];
  /** ISS-4762: labels the ceiling refused, reported back to the producer. */
  droppedLabels: string[];
};

type ResolvedCreateRequest =
  | { ok: true; value: CreateRequestContext }
  | { ok: false; status: number; error: string };

/** Parse + authorize the request body. No I/O beyond the sandbox check. */
function resolveCreateRequest(
  context: OperationRequestContext,
  getAllowedDirectories: () => string[]
): ResolvedCreateRequest {
  const body = parseBody(context);
  if (!body) {
    return { ok: false, status: 400, error: "Invalid JSON body" };
  }

  const repoPath = asString(body.repoPath);
  if (!repoPath) {
    return { ok: false, status: 400, error: "repoPath is required" };
  }
  const title = asString(body.title);
  if (!title) {
    return { ok: false, status: 400, error: "title is required" };
  }

  let cwd: string;
  try {
    cwd = assertRepoAllowed(repoPath, getAllowedDirectories());
  } catch (error) {
    if (error instanceof DirectoryNotAllowedError) {
      return { ok: false, status: 403, error: "directory not allowed" };
    }
    throw error;
  }

  const description = asString(body.body) ?? "";
  const ticketUrl = asString(body.ticketUrl);
  const requested = parseRequestedLabels(body.labels);
  return {
    ok: true,
    value: {
      cwd,
      title,
      fullBody: ticketUrl
        ? `${description}\n\n---\nLinear: ${ticketUrl}`.trim()
        : description,
      labels: requested.labels,
      droppedLabels: requested.droppedTagNames,
    },
  };
}

/** Push the current branch and open the PR, then label it. */
async function createPullRequest(
  request: CreateRequestContext,
  ghBin: string
): Promise<Record<string, unknown>> {
  const { cwd } = request;
  const currentBranch = await runRead(cwd, getResolvedGitPath(), [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  await run(cwd, getResolvedGitPath(), ["push", "-u", "origin", currentBranch]);

  const createOutput = await runRead(cwd, ghBin, [
    "pr",
    "create",
    "--head",
    currentBranch,
    "--title",
    request.title,
    "--body",
    request.fullBody,
  ]);

  const parsedFromUrl = parsePrNumber(createOutput);
  if (parsedFromUrl) {
    return {
      success: true,
      url: createOutput,
      number: parsedFromUrl,
      message: `Created PR #${parsedFromUrl}`,
      ...(await labelResponseFields(cwd, ghBin, parsedFromUrl, request)),
    };
  }

  const view = await readPullRequestView(cwd, ghBin);
  return {
    success: true,
    url: view.url,
    number: view.number,
    message: `Created PR #${view.number ?? "unknown"}`,
    ...(await labelResponseFields(cwd, ghBin, view.number, request)),
  };
}

/**
 * `gh pr create` fails with "already exists" when the branch already has a PR.
 * Resolve that PR instead of erroring — and still apply the requested labels,
 * so re-running the flow after a tag change converges.
 */
async function viewExistingPullRequest(
  request: CreateRequestContext,
  ghBin: string,
  error: unknown
): Promise<Record<string, unknown> | null> {
  if (!String(error).includes("already exists")) {
    return null;
  }
  try {
    const view = await readPullRequestView(request.cwd, ghBin);
    return {
      success: true,
      url: view.url,
      number: view.number,
      message: `PR #${view.number ?? "unknown"} already exists`,
      ...(await labelResponseFields(request.cwd, ghBin, view.number, request)),
    };
  } catch {
    return null;
  }
}

async function readPullRequestView(
  cwd: string,
  ghBin: string
): Promise<{ url?: string; number?: number }> {
  const view = await runRead(cwd, ghBin, [
    "pr",
    "view",
    "--json",
    "url,number",
  ]);
  return pullRequestViewSchema.parse(JSON.parse(view));
}

const pullRequestViewSchema = z.object({
  url: z.string().optional(),
  number: z.number().optional(),
});

/**
 * Read the optional `labels` field. Unknown/invalid shapes degrade to "no
 * labels requested" instead of a 400 so a version-skewed client cannot lose the
 * ability to open a PR.
 *
 * ISS-4762: the parse is now per-ELEMENT and clamping rather than whole-array
 * and rejecting. The old whole-array validator carried a `.max(25)`, so a
 * newer client sending 26 labels got ZERO of them — the exact silent-loss
 * failure this ticket exists to remove. A set past the ceiling is clamped (and
 * the excess reported), and one malformed entry costs only that entry.
 */
export function parseRequestedLabels(value: unknown): PullRequestLabelMapping {
  if (value === undefined || value === null) {
    return { labels: [], droppedTagNames: [], rejectedCount: 0 };
  }
  const mapping = parsePullRequestLabelSpecList(value);
  if (mapping.rejectedCount > 0) {
    // ISS-4764: still fail-open — a malformed element never blocks PR creation.
    // But a silent skip made "every element was garbage" look identical to "no
    // labels requested", so the count goes to the gateway monitor where the
    // shape drift is actually actionable.
    gatewayLog.warn(
      GATEWAY_LOG_TAG,
      `Skipped ${mapping.rejectedCount} malformed PR label(s); applying ${mapping.labels.length}`
    );
  }
  return mapping;
}

/**
 * Response fields describing the labelling outcome. Omitted entirely when the
 * caller requested no labels, so the existing response shape is unchanged for
 * older clients (an absent optional field stays absent — never `null`).
 *
 * ISS-4762: `droppedLabels` is present only when the ceiling actually refused
 * something, so a producer can tell "applied everything you asked for" from
 * "applied what fits". Silence still means nothing was dropped.
 *
 * ISS-4764: `labelsApplied` means EVERY requested label landed, not "the first
 * batch landed". Labels are applied in successive bounded batches, so a failure
 * on batch two used to be reported as a flat success by batch one, and the
 * names that never made it were absent from the response entirely. The
 * remainder is now named in `unappliedLabels` — additive and optional, present
 * only when something is actually missing, so an older client that ignores it
 * behaves exactly as before.
 */
async function labelResponseFields(
  cwd: string,
  ghBin: string,
  prNumber: number | undefined,
  request: Pick<CreateRequestContext, "labels" | "droppedLabels">
): Promise<{
  appliedLabels?: string[];
  labelsApplied?: boolean;
  droppedLabels?: string[];
  unappliedLabels?: string[];
}> {
  const dropped =
    request.droppedLabels.length > 0
      ? { droppedLabels: request.droppedLabels }
      : {};
  if (request.labels.length === 0) {
    return dropped;
  }
  const requestedNames = request.labels.map((label) => label.name);
  if (!prNumber) {
    return {
      appliedLabels: [],
      labelsApplied: false,
      unappliedLabels: requestedNames,
      ...dropped,
    };
  }

  const applied = await applyPullRequestLabels(
    cwd,
    ghBin,
    prNumber,
    request.labels
  );
  const appliedNames = new Set(applied);
  const unapplied = requestedNames.filter((name) => !appliedNames.has(name));
  return {
    appliedLabels: applied,
    labelsApplied: unapplied.length === 0,
    ...(unapplied.length > 0 ? { unappliedLabels: unapplied } : {}),
    ...dropped,
  };
}

/**
 * Create any label the repository is missing, then add the whole set to the PR.
 *
 * The add call (`POST .../issues/{n}/labels`) is additive — it never removes a
 * label a human added by hand — and re-adding a label the PR already carries is
 * a no-op, so the pass is safe to repeat. Label creation tolerates the "already
 * exists" race, matching the cloud reconciliation path in `@repo/github`.
 *
 * That cloud path is deliberately NOT reused here, and the parallel is not
 * shareable as written: `@repo/github` is a `server-only`, Octokit-typed
 * package that `apps/desktop` does not (and must not) depend on — the gateway
 * shells out to the operator's local `gh` session rather than GitHub App
 * installation credentials. What CAN be shared is shared: the decision of which
 * labels are missing runs through `pullRequestLabelsToAdd` from `@repo/api`, so
 * the case-folding/dedupe semantics are single-sourced and only the transport
 * (subprocess vs REST client) differs.
 */
async function applyPullRequestLabels(
  cwd: string,
  ghBin: string,
  prNumber: number,
  labels: readonly PullRequestLabelSpec[]
): Promise<string[]> {
  const repoSlug = await getRepoSlug(cwd);
  if (!repoSlug) {
    return [];
  }

  // Same shared, case-insensitive diff the cloud reconciliation path uses, so
  // the local gh-CLI and cloud Octokit label passes cannot drift.
  const existing = await listRepositoryLabelNames(cwd, ghBin, repoSlug);
  for (const label of pullRequestLabelsToAdd(existing, labels)) {
    await createRepositoryLabel(cwd, ghBin, repoSlug, label);
  }

  // Add via the REST array endpoint, NOT `gh pr edit --add-label`. `--add-label`
  // is a comma-splitting string-slice flag, so a label name that legitimately
  // contains a comma ("perf, p1") is silently torn into two wrong labels even
  // when passed as one repeated flag. `POST .../issues/{n}/labels` with a
  // repeated `-f 'labels[]=<name>'` per label treats each name literally, and
  // the endpoint is additive server-side (it never removes a label a human
  // added by hand), so the pass stays safe to repeat.
  //
  // ISS-4762: issued as successive BOUNDED BATCHES, matching the cloud
  // reconciliation path, so a set larger than one provider write still lands in
  // full instead of being truncated to the first batch.
  const applied: string[] = [];
  for (const batch of batchPullRequestLabels(labels)) {
    const addLabelArgs = batch.flatMap((label) => [
      "-f",
      `labels[]=${label.name}`,
    ]);
    try {
      await run(cwd, ghBin, [
        "api",
        "--method",
        "POST",
        `repos/${repoSlug}/issues/${prNumber}/labels`,
        ...addLabelArgs,
      ]);
      applied.push(...batch.map((label) => label.name));
    } catch {
      // Labelling is best effort — the PR itself already exists and is
      // reported. Return the batches that DID land rather than claiming none
      // did, so the response describes the PR's real state.
      return applied;
    }
  }
  return applied;
}

/**
 * Read the repository's existing label names, bounded to the same page budget
 * as the cloud path (`MAX_LABEL_PAGES` in `@repo/github/pull-request-labels`):
 * explicit `page=N` requests rather than `gh --paginate`, which would follow
 * Link headers indefinitely on a repo with a huge label inventory. Labels past
 * the cap simply look missing, and the 422 "already exists" tolerance in
 * `createRepositoryLabel` absorbs that safely.
 */
async function listRepositoryLabelNames(
  cwd: string,
  ghBin: string,
  repoSlug: string
): Promise<string[]> {
  const names: string[] = [];
  try {
    for (let page = 1; page <= MAX_LABEL_PAGES; page++) {
      const output = await runRead(cwd, ghBin, [
        "api",
        `repos/${repoSlug}/labels?per_page=${LABEL_PAGE_SIZE}&page=${page}`,
        "--jq",
        LABEL_NAME_JQ,
      ]);
      const pageNames = output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      names.push(...pageNames);
      if (pageNames.length < LABEL_PAGE_SIZE) {
        break;
      }
    }
    return names;
  } catch {
    // Unknown label inventory: fall through and let create-if-missing rely on
    // the "already exists" tolerance below.
    return [];
  }
}

/** Create one repository label, tolerating a concurrent create. */
async function createRepositoryLabel(
  cwd: string,
  ghBin: string,
  repoSlug: string,
  label: PullRequestLabelSpec
): Promise<void> {
  const args = [
    "api",
    "--method",
    "POST",
    `repos/${repoSlug}/labels`,
    "-f",
    `name=${label.name}`,
    "-f",
    `color=${label.color}`,
  ];
  if (label.description) {
    args.push("-f", `description=${label.description}`);
  }
  try {
    await run(cwd, ghBin, args);
  } catch {
    // Already exists (422) or a transient failure — the `issues/{n}/labels`
    // add call below reports the real outcome, so never fail PR creation here.
  }
}

const GATEWAY_LOG_TAG = "git-pr-create";
const LABEL_PAGE_SIZE = 100;
/** Mirrors `MAX_LABEL_PAGES` in `@repo/github/pull-request-labels` (500 labels). */
const MAX_LABEL_PAGES = 5;
const LABEL_NAME_JQ = ".[].name";
