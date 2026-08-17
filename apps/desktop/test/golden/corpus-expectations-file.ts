import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export function assertCorpusExpectationsWritable(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }

  const document: unknown = parseYaml(readFileSync(filePath, "utf8"));
  if (!isRecord(document)) {
    throw new Error(
      `Refusing to overwrite invalid corpus expectations at ${filePath}`
    );
  }

  const { status } = document;
  if (status === CorpusExpectationsStatus.Signed) {
    throw new Error(
      `Refusing to overwrite SIGNED corpus expectations at ${filePath}; ` +
        "generate to a temporary --output path and review the diff " +
        "(packages/golden-sessions/AGENTS.md)"
    );
  }
  if (status !== CorpusExpectationsStatus.Proposed) {
    throw new Error(
      `Refusing to overwrite corpus expectations with unknown status ${String(status)} at ${filePath}`
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const CorpusExpectationsStatus = {
  Proposed: "PROPOSED",
  Signed: "SIGNED",
} as const;
