/**
 * Behavior tests for `helpers/storybook-config-source.ts`, the AST reader two
 * guards (`story-glob-parity`, `app-core-harness-single-mount`) share. Those
 * guards only ever read the real `main.ts`, whose `stories` array is five bare
 * strings — so the object-entry form Storybook also accepts, and the refusal
 * on an entry the reader cannot resolve, were never exercised. A synthetic
 * config per case pins each shape.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STORYBOOK_MAIN_PATH,
  storybookStoryPatterns,
  visitSource,
} from "./helpers/storybook-config-source";

const tempDirs: string[] = [];
const UNRESOLVABLE_ENTRY =
  /cannot resolve a story root from `stories` entry `shared`/;

function writeConfig(source: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "storybook-config-source-"));
  tempDirs.push(dir);
  const file = path.join(dir, "main.ts");
  writeFileSync(file, source);
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("storybookStoryPatterns", () => {
  it("reads the real config's five bare-glob entries in declaration order", () => {
    const patterns = storybookStoryPatterns();
    expect(patterns).toHaveLength(5);
    expect(patterns[0]).toContain("*.mdx");
    expect(patterns.every((pattern) => pattern.includes("stories"))).toBe(true);
    expect(storybookStoryPatterns(STORYBOOK_MAIN_PATH)).toEqual(patterns);
  });

  it("joins an object entry's directory and files, tolerating a missing half", () => {
    const file = writeConfig(`
      const config = {
        stories: [
          "../stories/**/*.stories.tsx",
          { directory: "../../packages/app", files: "**/*.stories.tsx" },
          { directory: "../../apps/desktop" },
          { files: "**/*.mdx" },
          { directory: "../ignored", files: 42, titlePrefix: "x" },
        ],
      };
      export default config;
    `);

    expect(storybookStoryPatterns(file)).toEqual([
      "../stories/**/*.stories.tsx",
      "../../packages/app/**/*.stories.tsx",
      "../../apps/desktop",
      "**/*.mdx",
      "../ignored",
    ]);
  });

  it("refuses an entry it cannot resolve, naming the entry and the file", () => {
    const file = writeConfig(`
      const shared = "../stories/**/*.stories.tsx";
      export default { stories: ["../stories/**/*.mdx", shared] };
    `);

    expect(() => storybookStoryPatterns(file)).toThrow(UNRESOLVABLE_ENTRY);
    // The full temp path, not a `main.ts` suffix: the real config is also
    // named `main.ts`, so a suffix match would pass against a message that
    // named `STORYBOOK_MAIN_PATH` instead of the file actually read.
    expect(() => storybookStoryPatterns(file)).toThrow(`in ${file} —`);
    expect(() => storybookStoryPatterns(file)).not.toThrow(STORYBOOK_MAIN_PATH);
  });

  it("ignores a `stories` property that is not an array literal", () => {
    const file = writeConfig(`
      const stories = ["../stories/**/*.mdx"];
      export default { stories, other: { stories: "nope" } };
    `);

    expect(storybookStoryPatterns(file)).toEqual([]);
  });
});

describe("visitSource", () => {
  it("visits every node of the file, root first", () => {
    const file = writeConfig("export const a = 1;\nexport const b = a + 1;\n");
    const kinds: string[] = [];
    visitSource(file, (node) => {
      kinds.push(node.constructor.name);
    });
    expect(kinds[0]).toBe("SourceFileObject");
    expect(kinds.length).toBeGreaterThan(5);
  });
});
