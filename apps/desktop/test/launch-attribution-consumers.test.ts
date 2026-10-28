import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildBoundedComponentUsage,
  buildSessionComponentUsageField,
  readLaunchAttributedSkill,
} from "../src/main/database/component-usage-budget";
import type { SqliteComponentUsageRow } from "../src/main/database/db-row-types";
import {
  buildSessionAutonomyInput,
  buildSessionAutonomyInputFromTrace,
  readLaunchAttributionForAutonomy,
} from "../src/main/database/session-trace-autonomy-input";

/**
 * ISS-7259: the two consumers of the persisted launch-attribution facet —
 * autonomy scoring and component attribution.
 *
 * The facet is only worth capturing if something reads it, so these assert the
 * READ, not the shape. The autonomy cases pin which harness statements may widen
 * `headless` and, just as importantly, which may not; the component cases pin the
 * anti-double-count rule the ticket set.
 */

/** An interactive entrypoint — so `headless` can only come from the facet. */
const INTERACTIVE_ENTRYPOINT = "cli";

function autonomyInput(
  launchAttribution?: Parameters<
    typeof buildSessionAutonomyInput
  >[0]["launchAttribution"]
) {
  return buildSessionAutonomyInput({
    entrypoint: INTERACTIVE_ENTRYPOINT,
    hasTranscript: true,
    launchAttribution,
    timelineRows: [],
    tokenEvents: [],
  });
}

test("ISS-7259: an agent-spawned thread scores headless on an interactive entrypoint", () => {
  // The entrypoint alone says attended; the harness says the thread was spawned
  // by another agent, so nobody was there. Without this leg the run is scored as
  // if a person sat through it.
  assert.equal(autonomyInput({ threadSource: "subagent" }).headless, true);
});

test("ISS-7259: an SDK-injected first prompt scores headless", () => {
  assert.equal(
    autonomyInput({ threadSource: "unstated", promptSource: "sdk" }).headless,
    true
  );
});

test("ISS-7259: a typed prompt on a user thread stays attended", () => {
  // The negative control that makes the two above mean something: the same
  // facet shape, stating a PERSON, must not widen headless.
  assert.equal(
    autonomyInput({ threadSource: "user", promptSource: "typed" }).headless,
    false
  );
});

test("ISS-7259: a queued prompt stays attended", () => {
  // `queued` is a person queueing their own turns while the agent works. Reading
  // it as unattended would score the most hands-on sessions in the corpus as
  // fully autonomous.
  assert.equal(
    autonomyInput({ threadSource: "unstated", promptSource: "queued" })
      .headless,
    false
  );
});

test("ISS-7259: a session with no facet is unchanged", () => {
  // Every session before DATA_REVISION 86. The new leg must contribute nothing
  // rather than default either way.
  assert.equal(autonomyInput(undefined).headless, false);
});

test("ISS-7259: the autonomy reader takes the facet off the metadata blob", () => {
  // The production path reads an untyped blob, not a typed facet, so the reader
  // is what actually connects the capture to the score.
  const attribution = readLaunchAttributionForAutonomy({
    harnessLaunchAttribution: { threadSource: "subagent" },
  });

  assert.equal(
    buildSessionAutonomyInput({
      entrypoint: INTERACTIVE_ENTRYPOINT,
      hasTranscript: true,
      launchAttribution: attribution,
      timelineRows: [],
      tokenEvents: [],
    }).headless,
    true
  );
});

test("ISS-7259: a malformed metadata blob yields no facet rather than throwing", () => {
  assert.equal(readLaunchAttributionForAutonomy(null), undefined);
  assert.equal(readLaunchAttributionForAutonomy({}), undefined);
  assert.equal(
    readLaunchAttributionForAutonomy({ harnessLaunchAttribution: "nonsense" }),
    undefined
  );
});

test("ISS-7259: the launch attribution flags the skill's existing usage row, and adds none", () => {
  const rows = [
    usageRow("skill", "cl-produce"),
    usageRow("skill", "logical-qa"),
    usageRow("tool", "cl-produce"),
  ];

  const built = buildBoundedComponentUsage(rows, undefined, "cl-produce");
  const components = "components" in built ? built.components : [];

  // The ticket's rule: one row, flagged — never a second row for the launch, or
  // `cl-produce` is counted as both an invocation and a launch.
  assert.equal(components.length, 3);
  assert.deepEqual(
    components.map((c) => [
      c.componentKind,
      c.componentKey,
      c.isFirstAttributedSkill,
    ]),
    [
      ["skill", "cl-produce", true],
      ["skill", "logical-qa", undefined],
      // Same key, different kind: a tool named for the skill is not the skill.
      ["tool", "cl-produce", undefined],
    ]
  );
});

test("ISS-7259: the flag is OMITTED, never sent false", () => {
  const built = buildBoundedComponentUsage([usageRow("skill", "cl-produce")]);
  const components = "components" in built ? built.components : [];

  // Omission is the contract: an older cloud that never learned the field must
  // be indistinguishable from one that learned it and saw no launch.
  assert.equal(
    Object.hasOwn(components[0], "isFirstAttributedSkill"),
    false,
    "an unflagged row must not carry the key at all"
  );
});

test("ISS-7259: the component reader ignores an over-long skill name", () => {
  assert.equal(
    readLaunchAttributedSkill({
      harnessLaunchAttribution: { firstAttributedSkill: "s".repeat(129) },
    }),
    null
  );
  assert.equal(
    readLaunchAttributedSkill({
      harnessLaunchAttribution: { firstAttributedSkill: "cl-produce" },
    }),
    "cl-produce"
  );
});

function usageRow(kind: string, key: string): SqliteComponentUsageRow {
  return {
    session_id: "s1",
    component_kind: kind,
    component_key: key,
    git_branch: "",
    agent_component_id: null,
    harness: "claude",
    invocations: 1,
    error_count: 0,
    component_version_hash: null,
    first_invoked_at: null,
    last_invoked_at: null,
  } as SqliteComponentUsageRow;
}

/**
 * The two seams PRODUCTION actually calls. Everything above pins the inner
 * helpers, which leaves the wiring itself untested: deleting the
 * `readLaunchAttributionForAutonomy(metadata)` / `readLaunchAttributedSkill(metadata)`
 * argument inside these wrappers kills the feature in production while every
 * other case here stays green, because they hand the facet in themselves.
 */
test("ISS-7259: the autonomy seam production calls reads the facet off metadata", () => {
  const input = buildSessionAutonomyInputFromTrace(
    {
      entrypoint: INTERACTIVE_ENTRYPOINT,
      harnessLaunchAttribution: { threadSource: "subagent" },
    },
    [],
    []
  );

  assert.equal(input.headless, true);
});

test("ISS-7259: the autonomy seam leaves an unattributed session attended", () => {
  const input = buildSessionAutonomyInputFromTrace(
    { entrypoint: INTERACTIVE_ENTRYPOINT },
    [],
    []
  );

  assert.equal(input.headless, false);
});

test("ISS-7259: the component seam production calls reads the skill off metadata", () => {
  const built = buildSessionComponentUsageField(
    [usageRow("skill", "cl-produce"), usageRow("skill", "logical-qa")],
    { harnessLaunchAttribution: { firstAttributedSkill: "cl-produce" } },
    () => undefined
  );
  const components = "components" in built ? built.components : [];

  assert.deepEqual(
    components.map((c) => [c.componentKey, c.isFirstAttributedSkill]),
    [
      ["cl-produce", true],
      ["logical-qa", undefined],
    ]
  );
});
