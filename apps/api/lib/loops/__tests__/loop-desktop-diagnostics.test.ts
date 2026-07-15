/**
 * Unit tests for getImplementationPlanPayloadDiagnostics() in
 * loop-desktop-diagnostics.ts.
 *
 * Covers the plan-raw-content diagnostic branches used for launch-log
 * enrichment:
 * - implementation-plan artifact absent
 * - artifact present without a raw record
 * - artifact present with raw content matching the artifact content
 * - artifact present with raw content mismatching the artifact content
 */

import { DocumentType } from "@repo/api/src/types/document";
import { LoopCommand } from "@repo/api/src/types/loop";
import { shortContentHash } from "@repo/observability/content-hash";
import { describe, expect, it } from "vitest";
import { getImplementationPlanPayloadDiagnostics } from "../loop-desktop-diagnostics";
import type { ContextPack } from "../loop-state";

type Artifact = ContextPack["artifacts"][number];

const planArtifact = (
  overrides: Partial<Artifact> & Pick<Artifact, "content">
): Artifact => ({
  id: "doc-1",
  type: DocumentType.ImplementationPlan,
  title: "Plan",
  ...overrides,
});

const contextPackWith = (artifacts: Artifact[]): ContextPack => ({
  command: LoopCommand.Execute,
  artifacts,
});

describe("getImplementationPlanPayloadDiagnostics", () => {
  it("reports absence when no implementation-plan artifact is present", () => {
    const contextPack = contextPackWith([
      { id: "other", type: "PRD", title: "PRD", content: "prd body" },
    ]);

    expect(getImplementationPlanPayloadDiagnostics(contextPack)).toEqual({
      artifactCount: 1,
      implementationPlanArtifactPresent: false,
      implementationPlanRawRecordPresent: false,
      implementationPlanRawContentPresent: false,
      implementationPlanRawContentMatchesArtifact: null,
      implementationPlanRawReusableByDesktop: null,
      implementationPlanContentLength: null,
      implementationPlanRawContentLength: null,
      implementationPlanContentHash: null,
      implementationPlanRawContentHash: null,
    });
  });

  it("reports present-without-raw when the plan artifact has no raw record", () => {
    const contextPack = contextPackWith([
      planArtifact({ content: "plan body" }),
    ]);

    expect(getImplementationPlanPayloadDiagnostics(contextPack)).toEqual({
      artifactCount: 1,
      implementationPlanArtifactPresent: true,
      implementationPlanRawRecordPresent: false,
      implementationPlanRawContentPresent: false,
      implementationPlanRawContentMatchesArtifact: null,
      implementationPlanRawReusableByDesktop: false,
      implementationPlanContentLength: "plan body".length,
      implementationPlanRawContentLength: null,
      implementationPlanContentHash: shortContentHash("plan body"),
      implementationPlanRawContentHash: null,
    });
  });

  it("reports a match when raw content equals the artifact content", () => {
    const content = "identical plan body";
    const contextPack = contextPackWith([
      planArtifact({ content, raw: { content } }),
    ]);

    expect(getImplementationPlanPayloadDiagnostics(contextPack)).toEqual({
      artifactCount: 1,
      implementationPlanArtifactPresent: true,
      implementationPlanRawRecordPresent: true,
      implementationPlanRawContentPresent: true,
      implementationPlanRawContentMatchesArtifact: true,
      implementationPlanRawReusableByDesktop: true,
      implementationPlanContentLength: content.length,
      implementationPlanRawContentLength: content.length,
      implementationPlanContentHash: shortContentHash(content),
      implementationPlanRawContentHash: shortContentHash(content),
    });
  });

  it("reports a mismatch when raw content differs from the artifact content", () => {
    const content = "rendered plan body";
    const rawContent = "raw plan body";
    const contextPack = contextPackWith([
      planArtifact({ content, raw: { content: rawContent } }),
    ]);

    expect(getImplementationPlanPayloadDiagnostics(contextPack)).toEqual({
      artifactCount: 1,
      implementationPlanArtifactPresent: true,
      implementationPlanRawRecordPresent: true,
      implementationPlanRawContentPresent: true,
      implementationPlanRawContentMatchesArtifact: false,
      implementationPlanRawReusableByDesktop: false,
      implementationPlanContentLength: content.length,
      implementationPlanRawContentLength: rawContent.length,
      implementationPlanContentHash: shortContentHash(content),
      implementationPlanRawContentHash: shortContentHash(rawContent),
    });
  });

  it("treats a raw record without string content as raw-content absent", () => {
    const content = "plan body";
    const contextPack = contextPackWith([
      planArtifact({ content, raw: { contentType: "markdown" } }),
    ]);

    expect(getImplementationPlanPayloadDiagnostics(contextPack)).toMatchObject({
      implementationPlanArtifactPresent: true,
      implementationPlanRawRecordPresent: true,
      implementationPlanRawContentPresent: false,
      implementationPlanRawContentMatchesArtifact: null,
      implementationPlanRawReusableByDesktop: false,
      implementationPlanRawContentLength: null,
      implementationPlanRawContentHash: null,
    });
  });
});
