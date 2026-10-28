import assert from "node:assert/strict";
import {
  ArtifactRefConfidence,
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { describe, test } from "vitest";
import { extractArtifactRefs } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import { makeSession, NOW } from "./artifact-ref-session-fixture.js";

const REPO = "closedloop-ai/closedloop-ai";
const PR_URL = `https://github.com/${REPO}/pull/12`;

describe("extractHarnessPrLinkRefs — ISS-7970 integer guard", () => {
  test("prNumber: 12 mints a harness_record ref at the highest confidence", () => {
    const session = makeSession({
      prLinks: [{ number: "12", repo: REPO, url: PR_URL }],
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: `echo ${PR_URL}` },
          output: `${PR_URL}\n`,
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const pullRequestRefs = refs.filter(
      (r) =>
        r.targetKind === ArtifactRefTargetKind.PullRequest &&
        r.prNumber === 12 &&
        r.repoFullName === REPO
    );
    assert.equal(
      pullRequestRefs.length,
      1,
      "the harness_record must outrank and replace the duplicate url_match ref"
    );
    const [harness] = pullRequestRefs;
    assert.ok(harness, "expected a harness_record ref for prNumber 12");
    assert.equal(harness.prNumber, 12);
    assert.equal(harness.targetIdentity, `${REPO}#12`);
    assert.equal(harness.confidence, ArtifactRefConfidence.HarnessRecord);
    assert.equal(harness.method, ArtifactRefMethod.HarnessPrLink);
    assert.equal(harness.relation, ArtifactRefRelation.Referenced);
  });

  test("prNumber: 1.5 mints no harness_record ref; url_match from tool output survives", () => {
    const session = makeSession({
      prLinks: [{ number: "1.5", repo: REPO, url: PR_URL }],
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: `echo ${PR_URL}` },
          output: `${PR_URL}\n`,
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const harnessRefs = refs.filter(
      (r) =>
        r.targetKind === ArtifactRefTargetKind.PullRequest &&
        r.confidence === ArtifactRefConfidence.HarnessRecord &&
        r.repoFullName === REPO
    );
    assert.equal(
      harnessRefs.length,
      0,
      "fractional prNumber must not mint a harness_record ref"
    );
    const urlMatch = refs.find(
      (r) =>
        r.targetKind === ArtifactRefTargetKind.PullRequest &&
        r.confidence === ArtifactRefConfidence.UrlMatch &&
        r.prNumber === 12
    );
    assert.ok(
      urlMatch,
      "the url_match ref from tool output must survive when the harness_record is rejected"
    );
  });

  test("prNumber: 0 mints no harness_record ref", () => {
    const session = makeSession({
      prLinks: [{ number: "0", repo: REPO, url: PR_URL }],
    });
    const refs = extractArtifactRefs(session, NOW);
    const harnessRefs = refs.filter(
      (r) =>
        r.targetKind === ArtifactRefTargetKind.PullRequest &&
        r.confidence === ArtifactRefConfidence.HarnessRecord &&
        r.repoFullName === REPO
    );
    assert.equal(
      harnessRefs.length,
      0,
      "prNumber 0 must not mint a harness_record ref"
    );
  });

  test("prNumber: -1 mints no harness_record ref", () => {
    const session = makeSession({
      prLinks: [{ number: "-1", repo: REPO, url: PR_URL }],
    });
    const refs = extractArtifactRefs(session, NOW);
    const harnessRefs = refs.filter(
      (r) =>
        r.targetKind === ArtifactRefTargetKind.PullRequest &&
        r.confidence === ArtifactRefConfidence.HarnessRecord &&
        r.repoFullName === REPO
    );
    assert.equal(
      harnessRefs.length,
      0,
      "prNumber -1 must not mint a harness_record ref"
    );
  });
});
