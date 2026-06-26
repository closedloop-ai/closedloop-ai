export type UploadedPlanArtifact = {
  content: string;
  raw?: Record<string, unknown>;
};

export const IMPORTED_PLAN_MARKDOWN_FILE = "imported-plan.md";
export const PLAN_SOURCE_MARKDOWN_FILE = "plan-source.md";

export function isRawPlanArtifact(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toUploadedPlanArtifact(
  plan: unknown
): UploadedPlanArtifact | undefined {
  if (isRawPlanArtifact(plan)) {
    return {
      content:
        typeof plan.content === "string"
          ? plan.content
          : JSON.stringify(plan, null, 2),
      raw: plan,
    };
  }

  if (typeof plan === "string") {
    return { content: plan };
  }

  return undefined;
}
