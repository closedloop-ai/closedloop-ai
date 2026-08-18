import { describe, expect, it } from "vitest";
import {
  batchPullRequestLabels,
  DEFAULT_TAG_LABEL_COLOR,
  mapTagsToPullRequestLabels,
  PullRequestLabelLimit,
  parsePullRequestLabelSpecList,
  pullRequestLabelSpecListValidator,
  pullRequestLabelsToAdd,
  TAG_COLOR_LABEL_HEX,
  TAG_LABEL_DESCRIPTION,
  tagToPullRequestLabel,
} from "../pull-request-label.ts";
import { TAG_COLORS, TagColor } from "../tag.ts";

describe("tagToPullRequestLabel", () => {
  it("maps a tag onto a GitHub label with the taxonomy colour", () => {
    expect(
      tagToPullRequestLabel({ name: "infra", color: TagColor.Blue })
    ).toEqual({
      name: "infra",
      color: TAG_COLOR_LABEL_HEX[TagColor.Blue],
      description: TAG_LABEL_DESCRIPTION,
    });
  });

  it("falls back to the neutral colour for a colour outside the taxonomy", () => {
    const label = tagToPullRequestLabel({
      name: "legacy",
      color: "chartreuse",
    });

    expect(label?.color).toBe(DEFAULT_TAG_LABEL_COLOR);
  });

  it("does not leak an Object.prototype member as the label colour", () => {
    // A plain-object lookup would return `Object` / a function here, typed as
    // string, and push it into the GitHub label payload.
    for (const inherited of ["constructor", "toString", "__proto__"]) {
      expect(
        tagToPullRequestLabel({ name: "legacy", color: inherited })?.color
      ).toBe(DEFAULT_TAG_LABEL_COLOR);
    }
  });

  it("drops a tag whose name is whitespace-only", () => {
    expect(
      tagToPullRequestLabel({ name: "   ", color: TagColor.Red })
    ).toBeNull();
  });

  it("truncates a name to GitHub's maximum label length", () => {
    const label = tagToPullRequestLabel({
      name: "x".repeat(PullRequestLabelLimit.MaxNameLength + 10),
      color: TagColor.Red,
    });

    expect(label?.name).toHaveLength(PullRequestLabelLimit.MaxNameLength);
  });
});

describe("mapTagsToPullRequestLabels", () => {
  it("dedupes case-insensitively, keeping the first tag", () => {
    const mapping = mapTagsToPullRequestLabels([
      { name: "Bug", color: TagColor.Red },
      { name: "bug", color: TagColor.Blue },
    ]);

    expect(mapping.labels).toEqual([
      {
        name: "Bug",
        color: TAG_COLOR_LABEL_HEX[TagColor.Red],
        description: TAG_LABEL_DESCRIPTION,
      },
    ]);
    expect(mapping.droppedTagNames).toEqual([]);
  });

  // ISS-4762: the batch size used to BE the cap, so an artifact with more tags
  // than one provider write could carry lost the excess. Everything up to the
  // ceiling must survive, batching or not.
  it("keeps every tag past the provider batch size", () => {
    const count = PullRequestLabelLimit.ApplyBatchSize + 1;
    const tags = Array.from({ length: count }, (_unused, index) => ({
      name: `tag-${String(index).padStart(3, "0")}`,
      color: TagColor.Teal,
    }));

    const mapping = mapTagsToPullRequestLabels(tags);

    expect(mapping.labels).toHaveLength(count);
    expect(mapping.droppedTagNames).toEqual([]);
    // The tag that used to be silently discarded is present.
    expect(mapping.labels.at(-1)?.name).toBe(
      `tag-${String(count - 1).padStart(3, "0")}`
    );
  });

  // ISS-4762: past the absolute ceiling the excess must be REPORTED, not
  // silently truncated into a result the caller reads as complete.
  it("reports the tags the ceiling refuses instead of dropping them silently", () => {
    const overflow = 3;
    const count = PullRequestLabelLimit.MaxLabelsPerPullRequest + overflow;
    const tags = Array.from({ length: count }, (_unused, index) => ({
      name: `tag-${String(index).padStart(3, "0")}`,
      color: TagColor.Teal,
    }));

    const mapping = mapTagsToPullRequestLabels(tags);

    expect(mapping.labels).toHaveLength(
      PullRequestLabelLimit.MaxLabelsPerPullRequest
    );
    expect(mapping.droppedTagNames).toHaveLength(overflow);
    // Deterministic: the first N of the caller's order win, and the named
    // remainder is exactly the tail — so the same artifact never yields a
    // different label set between passes.
    expect(mapping.droppedTagNames).toEqual(
      tags
        .slice(PullRequestLabelLimit.MaxLabelsPerPullRequest)
        .map((t) => t.name)
    );
  });

  // ISS-4764: an unusable tag name is skipped rather than failing the pass, but
  // the skip is COUNTED so it is distinguishable from "there were no tags".
  it("counts the tags whose names were unusable", () => {
    const mapping = mapTagsToPullRequestLabels([
      { name: "infra", color: TagColor.Blue },
      { name: "   ", color: TagColor.Green },
      { name: "", color: TagColor.Red },
    ]);

    expect(mapping.rejectedCount).toBe(2);
    expect(mapping.labels.map((label) => label.name)).toEqual(["infra"]);
  });

  it("emits specs every colour in the taxonomy validates against", () => {
    const mapping = mapTagsToPullRequestLabels(
      TAG_COLORS.map((color) => ({ name: `tag-${color}`, color }))
    );

    expect(
      pullRequestLabelSpecListValidator.safeParse(mapping.labels).success
    ).toBe(true);
    expect(mapping.labels).toHaveLength(TAG_COLORS.length);
  });
});

describe("batchPullRequestLabels", () => {
  it("splits a set larger than one provider write into bounded batches", () => {
    const count = PullRequestLabelLimit.ApplyBatchSize + 1;
    const { labels } = mapTagsToPullRequestLabels(
      Array.from({ length: count }, (_unused, index) => ({
        name: `tag-${String(index).padStart(3, "0")}`,
        color: TagColor.Teal,
      }))
    );

    const batches = batchPullRequestLabels(labels);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(PullRequestLabelLimit.ApplyBatchSize);
    expect(batches[1]).toHaveLength(1);
    expect(batches.flat()).toHaveLength(count);
  });

  it("produces no batch for an empty set, so no empty write is issued", () => {
    expect(batchPullRequestLabels([])).toEqual([]);
  });
});

describe("parsePullRequestLabelSpecList", () => {
  it("keeps the valid entries when one element is malformed", () => {
    const mapping = parsePullRequestLabelSpecList([
      { name: "infra", color: TAG_COLOR_LABEL_HEX[TagColor.Blue] },
      { name: "broken", color: "#not-hex" },
      { name: "docs", color: TAG_COLOR_LABEL_HEX[TagColor.Green] },
    ]);

    expect(mapping.labels.map((label) => label.name)).toEqual([
      "infra",
      "docs",
    ]);
  });

  // ISS-4764: skipping stays fail-open, but a SILENT skip made a payload whose
  // every element was malformed indistinguishable from one that asked for no
  // labels at all — so the caller had nothing to route to its monitor.
  it("counts the elements it skipped", () => {
    const mapping = parsePullRequestLabelSpecList([
      { name: "infra", color: TAG_COLOR_LABEL_HEX[TagColor.Blue] },
      { name: "broken", color: "#not-hex" },
      { name: "", color: TAG_COLOR_LABEL_HEX[TagColor.Green] },
    ]);

    expect(mapping.rejectedCount).toBe(2);
    expect(mapping.labels).toHaveLength(1);
  });

  it("counts nothing rejected when every element is usable", () => {
    const mapping = parsePullRequestLabelSpecList([
      { name: "infra", color: TAG_COLOR_LABEL_HEX[TagColor.Blue] },
    ]);

    expect(mapping.rejectedCount).toBe(0);
  });

  // ISS-4762: the previous whole-array `.max()` validator rejected an
  // over-ceiling payload outright, which turned "too many labels" into "no
  // labels at all". Clamp and report instead.
  it("clamps an over-ceiling payload instead of rejecting all of it", () => {
    const overflow = 2;
    const payload = Array.from(
      { length: PullRequestLabelLimit.MaxLabelsPerPullRequest + overflow },
      (_unused, index) => ({
        name: `tag-${String(index).padStart(3, "0")}`,
        color: TAG_COLOR_LABEL_HEX[TagColor.Teal],
      })
    );

    const mapping = parsePullRequestLabelSpecList(payload);

    expect(mapping.labels).toHaveLength(
      PullRequestLabelLimit.MaxLabelsPerPullRequest
    );
    expect(mapping.droppedTagNames).toHaveLength(overflow);
  });

  it("treats a non-array value as no labels requested", () => {
    expect(parsePullRequestLabelSpecList("infra,docs")).toEqual({
      labels: [],
      droppedTagNames: [],
      rejectedCount: 0,
    });
  });
});

describe("pullRequestLabelsToAdd", () => {
  it("returns only labels the PR does not already carry", () => {
    const { labels } = mapTagsToPullRequestLabels([
      { name: "infra", color: TagColor.Blue },
      { name: "docs", color: TagColor.Green },
    ]);

    const additions = pullRequestLabelsToAdd(["INFRA", "manual-label"], labels);

    expect(additions.map((label) => label.name)).toEqual(["docs"]);
  });

  it("never proposes removing a manually-added label", () => {
    const { labels } = mapTagsToPullRequestLabels([
      { name: "infra", color: TagColor.Blue },
    ]);

    const additions = pullRequestLabelsToAdd(
      ["needs-triage", "do-not-merge"],
      labels
    );

    expect(additions.map((label) => label.name)).toEqual(["infra"]);
  });
});
