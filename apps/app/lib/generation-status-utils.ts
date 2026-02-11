import type { GenerationStatus } from "@repo/api/src/types/artifact";

export function getStatusMessage(
  status: GenerationStatus["status"],
  command: GenerationStatus["command"]
): string {
  const isExecute = command === "execute";
  switch (status) {
    case "PENDING":
      return "Waiting to start...";
    case "QUEUED":
      return isExecute ? "Queued for execution..." : "Queued for generation...";
    case "RUNNING":
      return isExecute
        ? "Executing plan and creating PR..."
        : "Generating implementation plan...";
    case "FAILURE":
      return isExecute ? "Plan execution failed" : "Plan generation failed";
    default:
      return "";
  }
}

export function isActiveGenerationStatus(
  status: GenerationStatus["status"]
): boolean {
  return ["PENDING", "QUEUED", "RUNNING"].includes(status);
}
