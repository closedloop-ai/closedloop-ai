/**
 * Co-located diagnostics helper for loop-desktop.
 *
 * Pure log-enrichment computation extracted from loop-desktop.ts: derives
 * presence/length/hash/match facts about the implementation-plan artifact in a
 * ContextPack so the launch path can attach them to its dispatch log without
 * inlining branchy logic in the dispatcher.
 */

import { DocumentType } from "@repo/api/src/types/document";
import { shortContentHash } from "@repo/observability/content-hash";
import type { ContextPack } from "./loop-state";

export type ImplementationPlanPayloadDiagnostics = {
  artifactCount: number;
  implementationPlanArtifactPresent: boolean;
  implementationPlanRawRecordPresent: boolean;
  implementationPlanRawContentPresent: boolean;
  implementationPlanRawContentMatchesArtifact: boolean | null;
  implementationPlanRawReusableByDesktop: boolean | null;
  implementationPlanContentLength: number | null;
  implementationPlanRawContentLength: number | null;
  implementationPlanContentHash: string | null;
  implementationPlanRawContentHash: string | null;
};

export function getImplementationPlanPayloadDiagnostics(
  contextPack: ContextPack
): ImplementationPlanPayloadDiagnostics {
  const planArtifact = contextPack.artifacts.find(
    (artifact) => artifact.type === DocumentType.ImplementationPlan
  );
  const rawPlanContent =
    typeof planArtifact?.raw?.content === "string"
      ? planArtifact.raw.content
      : undefined;
  let implementationPlanRawReusableByDesktop: boolean | null = null;
  if (planArtifact && rawPlanContent !== undefined) {
    implementationPlanRawReusableByDesktop =
      rawPlanContent === planArtifact.content;
  } else if (planArtifact) {
    implementationPlanRawReusableByDesktop = false;
  }

  return {
    artifactCount: contextPack.artifacts.length,
    implementationPlanArtifactPresent: planArtifact !== undefined,
    implementationPlanRawRecordPresent: planArtifact?.raw !== undefined,
    implementationPlanRawContentPresent: rawPlanContent !== undefined,
    implementationPlanRawContentMatchesArtifact:
      planArtifact && rawPlanContent !== undefined
        ? rawPlanContent === planArtifact.content
        : null,
    implementationPlanRawReusableByDesktop,
    implementationPlanContentLength: planArtifact?.content.length ?? null,
    implementationPlanRawContentLength: rawPlanContent?.length ?? null,
    implementationPlanContentHash: shortContentHash(planArtifact?.content),
    implementationPlanRawContentHash: shortContentHash(rawPlanContent),
  };
}
