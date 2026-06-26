/** Tests for resolvePrimaryArtifact in symphony-loop. */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { LoopRequestBodySchema } from "@closedloop-ai/loops-api/desktop-request";
import { resolvePrimaryArtifact } from "../src/server/operations/symphony-loop.js";

const FEATURE_TYPE = "FEATURE";

const artifacts = [
  { id: "ref-001", type: FEATURE_TYPE, content: "REF CONTENT" },
  { id: "primary-001", type: FEATURE_TYPE, content: "PRIMARY CONTENT" },
] as Parameters<typeof resolvePrimaryArtifact>[0];

describe("resolvePrimaryArtifact", () => {
  test("id match: returns artifact matching primaryArtifactId regardless of position", () => {
    const result = resolvePrimaryArtifact(
      artifacts,
      FEATURE_TYPE,
      "primary-001"
    );
    assert.equal(result.id, "primary-001");
  });

  test("findLast fallback when primaryArtifactId is undefined", () => {
    const result = resolvePrimaryArtifact(artifacts, FEATURE_TYPE);
    assert.equal(result.id, "primary-001");
  });

  test("findLast fallback when primaryArtifactId provided but no id match (stale id)", () => {
    const result = resolvePrimaryArtifact(artifacts, FEATURE_TYPE, "stale-id");
    assert.equal(result.id, "primary-001");
  });

  test("throws when neither id match nor findLast finds an artifact", () => {
    assert.throws(
      () => resolvePrimaryArtifact([], FEATURE_TYPE),
      /no FEATURE artifact found/
    );
    assert.throws(
      () =>
        resolvePrimaryArtifact(
          [
            { id: "wrong-001", type: "PRD", content: "PRD content" },
          ] as Parameters<typeof resolvePrimaryArtifact>[0],
          FEATURE_TYPE
        ),
      /no FEATURE artifact found/
    );
  });
});

describe("interop", () => {
  test("old-backend interop: absent primaryArtifactId falls back to findLast", () => {
    const interopArtifacts = [
      { id: "ref-001", type: FEATURE_TYPE, content: "REF" },
      { id: "primary-001", type: FEATURE_TYPE, content: "PRIMARY" },
    ] as Parameters<typeof resolvePrimaryArtifact>[0];
    const result = resolvePrimaryArtifact(
      interopArtifacts,
      FEATURE_TYPE,
      undefined
    );
    assert.equal(result.content, "PRIMARY");
  });

  test("old-desktop Zod interop: LoopRequestBodySchema accepts body with primaryArtifactId without stripping it", () => {
    const body = {
      loopId: "loop-001",
      command: LoopCommand.Execute,
      closedLoopAuthToken: "token-abc",
      artifacts: [
        {
          id: "feat-001",
          type: "FEATURE",
          title: "My Feature",
          content: "Feature content",
        },
      ],
      primaryArtifactId: "doc-123",
    };
    const parsed = LoopRequestBodySchema.parse(body);
    assert.equal(parsed.primaryArtifactId, "doc-123");
  });
});
