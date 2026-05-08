import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const PATH_ARG_PATTERN =
  /apiClient\.(?:get|post|put|delete)(?:<[^>]+>)?\(\s*(`\/[^`]*`)/gs;
const INTERPOLATION_PATTERN = /\$\{([^}]+)\}/g;

describe("MCP tool path safety", () => {
  it("uses encodePathSegment for all interpolated path segments", async () => {
    const toolsDir = new URL("../tools/", import.meta.url);
    const entries = await readdir(toolsDir, { withFileTypes: true });
    const failures: string[] = [];

    for (const entry of entries) {
      if (!(entry.isFile() && entry.name.endsWith(".ts"))) {
        continue;
      }

      const fileUrl = new URL(entry.name, toolsDir);
      const source = await readFile(fileUrl, "utf8");
      const pathArgs = source.matchAll(PATH_ARG_PATTERN);
      for (const pathArgMatch of pathArgs) {
        const pathArg = pathArgMatch[1];
        if (!pathArg.includes("${")) {
          continue;
        }

        for (const interpolation of pathArg.matchAll(INTERPOLATION_PATTERN)) {
          const expression = interpolation[1]?.trim() ?? "";
          if (!expression.includes("encodePathSegment(")) {
            failures.push(`${entry.name}: ${pathArg}`);
            break;
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
