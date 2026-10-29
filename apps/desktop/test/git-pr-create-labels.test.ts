import assert from "node:assert/strict";
import {
  PullRequestLabelLimit,
  TAG_COLOR_LABEL_HEX,
  TAG_LABEL_DESCRIPTION,
} from "@repo/api/src/types/pull-request-label";
import { TagColor } from "@repo/api/src/types/tag";
import { afterEach, describe, test } from "vitest";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { parseRequestedLabels } from "../src/server/operations/git-pr-create.js";

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

afterEach(() => {
  gatewayLog.clear();
});

describe("parseRequestedLabels", () => {
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

  test("keeps valid labels when one element is malformed", () => {
    assert.deepEqual(
      parseRequestedLabels([
        INFRA_LABEL,
        { name: "bad", color: "nope" },
        DOCS_LABEL,
      ]).labels,
      [INFRA_LABEL, DOCS_LABEL]
    );
  });

  test("logs a bounded diagnostic count for malformed elements", () => {
    const parsed = parseRequestedLabels([
      INFRA_LABEL,
      { name: "bad", color: "nope" },
      { name: "worse" },
    ]);

    assert.equal(parsed.rejectedCount, 2);
    assert.deepEqual(parsed.labels, [INFRA_LABEL]);
    assert.equal(
      gatewayLog
        .getEntries()
        .some((entry) => entry.message.includes("Skipped 2 malformed")),
      true
    );
  });

  test("counts nothing rejected for a well-formed payload", () => {
    assert.equal(parseRequestedLabels([INFRA_LABEL]).rejectedCount, 0);
    assert.equal(parseRequestedLabels(undefined).rejectedCount, 0);
  });

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
