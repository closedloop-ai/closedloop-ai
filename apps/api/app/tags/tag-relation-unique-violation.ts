import { getPrismaErrorCode, matchesPrismaP2002Target } from "@/lib/db-utils";

const artifactTagUniqueIndex = "tag_artifacts_tag_id_artifact_id_key";
const artifactTagUniqueColumns = ["tag_id", "artifact_id"] as const;
const artifactTagUniqueFields = ["tagId", "artifactId"] as const;

/** Only this Artifact tag relation conflict is an idempotent edit retry. */
export function isDuplicateArtifactTagRelationViolation(
  error: unknown
): boolean {
  if (getPrismaErrorCode(error) !== "P2002") {
    return false;
  }
  return matchesPrismaP2002Target(error, (target) => {
    if (typeof target === "string") {
      return target === artifactTagUniqueIndex;
    }
    if (!Array.isArray(target)) {
      return false;
    }
    if (target.length === 1 && target[0] === artifactTagUniqueIndex) {
      return true;
    }
    return (
      matchesColumns(target, artifactTagUniqueColumns) ||
      matchesColumns(target, artifactTagUniqueFields)
    );
  });
}

function matchesColumns(
  target: unknown[],
  expected: readonly string[]
): boolean {
  return (
    target.length === expected.length &&
    expected.every((column) => target.includes(column))
  );
}
