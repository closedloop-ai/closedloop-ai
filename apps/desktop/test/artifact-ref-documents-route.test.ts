import assert from "node:assert/strict";
import {
  ArtifactRefConfidence,
  ArtifactRefMethod,
  ArtifactRefRelation,
} from "@repo/api/src/types/session-artifact-link";
import { describe, test } from "vitest";
import { extractArtifactRefs } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import { makeSession, NOW } from "./artifact-ref-session-fixture.js";

describe("ISS-12855: /<org>/documents/<slug> route extraction", () => {
  test("a /documents/ URL in tool output produces an output url_match ref", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: { command: "cat notes.txt" },
          output: "Spec: https://app.closedloop.ai/my-org/documents/PRD-77\n",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const ref = refs.find((r) => r.targetIdentity === "PRD-77");
    assert.equal(ref?.relation, ArtifactRefRelation.Output);
    assert.equal(ref?.confidence, ArtifactRefConfidence.UrlMatch);
    assert.equal(ref?.method, ArtifactRefMethod.UrlInMessage);
  });

  test("a /documents/ URL in message text survives dedup as url_match", () => {
    const session = makeSession({
      messages: [
        {
          role: "human",
          timestamp: null,
          text: "See https://app.closedloop.ai/my-org/documents/ISS-1035 for context.",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const forArtifact = refs.filter((r) => r.targetIdentity === "ISS-1035");
    assert.equal(forArtifact.length, 1);
    assert.equal(forArtifact[0].relation, ArtifactRefRelation.Input);
    assert.equal(forArtifact[0].confidence, ArtifactRefConfidence.UrlMatch);
    assert.equal(forArtifact[0].method, ArtifactRefMethod.UrlInMessage);
  });
});
