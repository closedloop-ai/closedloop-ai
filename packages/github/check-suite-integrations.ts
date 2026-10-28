// A rollup check run's integration, read without `CheckSuite.app` (ISS-11906).
//
// GitHub refuses `CheckSuite.app` to `GITHUB_TOKEN` when the suite's app is
// private (`datadog-closedloop-ai`), and one refused node costs its whole PR
// head the verdict. `Commit.checkSuites(filterBy: {appId})` names the same
// integration without reading the App object, so a reader on that token selects
// each check suite's `id` and resolves the integration here.

import { z } from "zod";

/** Each required integration's suites on one commit. Measured max on an open PR head 2026-10-03: 24. */
const SUITES_PAGE_SIZE = 100;

const INTEGRATION_ALIAS = /^integration(\d+)Suites$/;

const SuitePageSchema = z.object({
  pageInfo: z.object({ hasNextPage: z.boolean() }),
  nodes: z.array(z.object({ id: z.string() })),
});

const SuiteIdCheckRunSchema = z.looseObject({
  __typename: z.literal("CheckRun"),
  checkSuite: z.object({ createdAt: z.string().nullish(), id: z.string() }),
});

const CommitRollupSchema = z.looseObject({
  statusCheckRollup: z
    .looseObject({
      contexts: z.looseObject({ nodes: z.array(z.unknown()) }),
    })
    .nullable(),
});

/**
 * One aliased `checkSuites` page per integration, selected beside the commit's
 * `statusCheckRollup` and read back by {@link resolveCheckSuiteIntegrations}.
 */
export function integrationSuiteFields(
  integrationIds: readonly number[]
): string {
  return [...new Set(integrationIds)]
    .map(
      (id) =>
        `integration${id}Suites: checkSuites(first: ${SUITES_PAGE_SIZE}, filterBy: {appId: ${id}}) { pageInfo { hasNextPage } nodes { id } }`
    )
    .join("\n");
}

/**
 * Rewrites a commit's suite-id check runs into the `checkSuite.app` shape the
 * rollup schema reads, so every consumer keeps matching on `app.databaseId`.
 *
 * A suite no integration page lists has no required integration: `app: null`,
 * the same answer an absent `app` gives. When a page was cut, unreadable, or
 * empty that absence proves nothing — an empty page cannot tell an integration
 * that never ran from a listing that under-reads — so an unlisted check run
 * becomes a `null` node, the hole `rollupTruncated` already answers Unknown for.
 * Anything not in the suite-id shape passes through untouched for the rollup
 * schema to judge.
 */
export function resolveCheckSuiteIntegrations(commit: unknown): unknown {
  const parsed = CommitRollupSchema.safeParse(commit);
  if (!parsed.success || parsed.data.statusCheckRollup === null) {
    return commit;
  }

  const integrationOfSuite = new Map<string, number>();
  let listedEverySuite = true;
  for (const [key, value] of Object.entries(parsed.data)) {
    const alias = INTEGRATION_ALIAS.exec(key);
    if (alias === null) {
      continue;
    }
    const page = SuitePageSchema.safeParse(value);
    if (!page.success) {
      listedEverySuite = false;
      continue;
    }
    if (page.data.pageInfo.hasNextPage || page.data.nodes.length === 0) {
      listedEverySuite = false;
    }
    for (const suite of page.data.nodes) {
      integrationOfSuite.set(suite.id, Number(alias[1]));
    }
  }

  const rollup = parsed.data.statusCheckRollup;
  const nodes = rollup.contexts.nodes.map((node) => {
    const checkRun = SuiteIdCheckRunSchema.safeParse(node);
    if (!checkRun.success) {
      return node;
    }
    const { createdAt, id } = checkRun.data.checkSuite;
    const integrationId = integrationOfSuite.get(id);
    if (integrationId === undefined && !listedEverySuite) {
      return null;
    }
    return {
      ...checkRun.data,
      checkSuite: {
        createdAt,
        app: integrationId === undefined ? null : { databaseId: integrationId },
      },
    };
  });

  return {
    ...parsed.data,
    statusCheckRollup: {
      ...rollup,
      contexts: { ...rollup.contexts, nodes },
    },
  };
}
