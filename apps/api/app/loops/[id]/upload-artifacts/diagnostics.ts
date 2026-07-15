import type { JsonObject } from "@repo/api/src/types/common";
import { shortContentHash } from "@repo/observability/content-hash";
import { parseJsonObject } from "@/lib/json-schema";

export type PlanUploadDiagnostics = {
  planArtifactPresent: boolean;
  planRawRecordPresent: boolean;
  planRawContentPresent: boolean;
  planRawContentMatchesArtifact: boolean | null;
  planRawReusableByDesktop: boolean | null;
  planContentLength: number | null;
  planRawContentLength: number | null;
  planContentHash: string | null;
  planRawContentHash: string | null;
};

/**
 * Derives diagnostic facts about the uploaded `plan` artifact for log
 * enrichment only (see the upload-artifacts route). Pure: returns null/false
 * fields rather than throwing when the plan or its raw record is absent.
 */
export function getPlanUploadDiagnostics(
  artifacts: JsonObject
): PlanUploadDiagnostics {
  const planArtifact = parseJsonObject(artifacts.plan);
  const planContent =
    typeof planArtifact?.content === "string"
      ? planArtifact.content
      : undefined;
  const rawPlan = parseJsonObject(planArtifact?.raw);
  const rawPlanContent =
    typeof rawPlan?.content === "string" ? rawPlan.content : undefined;
  let planRawReusableByDesktop: boolean | null = null;
  if (planContent !== undefined && rawPlanContent !== undefined) {
    planRawReusableByDesktop = rawPlanContent === planContent;
  } else if (planContent !== undefined) {
    planRawReusableByDesktop = false;
  }

  return {
    planArtifactPresent: planArtifact !== null,
    planRawRecordPresent: rawPlan !== null,
    planRawContentPresent: rawPlanContent !== undefined,
    planRawContentMatchesArtifact:
      planContent !== undefined && rawPlanContent !== undefined
        ? rawPlanContent === planContent
        : null,
    planRawReusableByDesktop,
    planContentLength: planContent?.length ?? null,
    planRawContentLength: rawPlanContent?.length ?? null,
    planContentHash: shortContentHash(planContent),
    planRawContentHash: shortContentHash(rawPlanContent),
  };
}
