import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { encodePathSegment } from "../tools/tool-utils.js";

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

  it("rejects dot segments that URI-encoding cannot neutralize", () => {
    // `encodeURIComponent` leaves "." and ".." untouched, and `new URL()`
    // resolves them away — proving the hazard the guard exists for.
    for (const dotSegment of [".", ".."]) {
      expect(encodeURIComponent(dotSegment)).toBe(dotSegment);
      expect(() => encodePathSegment(dotSegment)).toThrow(
        "not a valid path segment"
      );
    }
    expect(
      new URL("/agent-sessions/../trace-comments", "https://api.test").pathname
    ).toBe("/trace-comments");
  });

  it("encodes an id that is not a UUID into exactly one path segment", () => {
    expect(encodePathSegment("trace-comments-missing-cloud-session")).toBe(
      "trace-comments-missing-cloud-session"
    );
    expect(encodePathSegment("../../admin")).toBe("..%2F..%2Fadmin");
    expect(
      new URL(
        `/agent-sessions/${encodePathSegment("../../admin")}/trace-comments`,
        "https://api.test"
      ).pathname
    ).toBe("/agent-sessions/..%2F..%2Fadmin/trace-comments");
  });
});
