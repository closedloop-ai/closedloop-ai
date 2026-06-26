import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRawPlanArtifact,
  toUploadedPlanArtifact,
} from "../src/shared/plan-artifact-utils.js";

test("isRawPlanArtifact only accepts plain object values", () => {
  assert.equal(isRawPlanArtifact({ content: "Plan" }), true);
  assert.equal(isRawPlanArtifact("plan"), false);
  assert.equal(isRawPlanArtifact(["plan"]), false);
  assert.equal(isRawPlanArtifact(null), false);
});

test("toUploadedPlanArtifact preserves raw plan objects and content", () => {
  const rawPlan = { content: "Plan content", pendingTasks: ["task-1"] };

  assert.deepEqual(toUploadedPlanArtifact(rawPlan), {
    content: "Plan content",
    raw: rawPlan,
  });
});

test("toUploadedPlanArtifact serializes raw objects without content", () => {
  const rawPlan = { pendingTasks: ["task-1"] };

  assert.deepEqual(toUploadedPlanArtifact(rawPlan), {
    content: JSON.stringify(rawPlan, null, 2),
    raw: rawPlan,
  });
});

test("toUploadedPlanArtifact wraps string plans without raw state", () => {
  assert.deepEqual(toUploadedPlanArtifact("Plan content"), {
    content: "Plan content",
  });
  assert.equal(toUploadedPlanArtifact(undefined), undefined);
});
