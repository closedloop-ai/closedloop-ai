import { describe, expect, it } from "vitest";
import {
  findBuildOutputProblems,
  findMissingExportProblems,
} from "../scripts/assert-build-output.mjs";

const exportsMap = {
  "./tokens": {
    types: "./dist/tokens.d.ts",
    import: "./dist/tokens.js",
    require: "./dist/tokens.cjs",
    default: "./dist/tokens.js",
  },
  "./commands": {
    types: "./dist/commands.d.ts",
    import: "./dist/commands.js",
    require: "./dist/commands.cjs",
    default: "./dist/commands.js",
  },
};

const declarationBody = "export type Token = { value: string };\n";
const runtimeBody = "export const token = 1;\n";

function buildFixture(
  overrides: Record<string, { size: number; body: string }>
) {
  const files: Record<string, { size: number; body: string }> = {
    "dist/tokens.d.ts": { size: declarationBody.length, body: declarationBody },
    "dist/tokens.js": { size: runtimeBody.length, body: runtimeBody },
    "dist/tokens.cjs": { size: runtimeBody.length, body: runtimeBody },
    "dist/commands.d.ts": {
      size: declarationBody.length,
      body: declarationBody,
    },
    "dist/commands.js": { size: runtimeBody.length, body: runtimeBody },
    "dist/commands.cjs": { size: runtimeBody.length, body: runtimeBody },
    ...overrides,
  };
  const packageDir = "/pkg";
  const statSize = (path: string) => {
    const relativePath = path.slice(packageDir.length + 1);
    const file = files[relativePath];
    return file ? file.size : null;
  };
  const readFile = (path: string) => {
    const relativePath = path.slice(packageDir.length + 1);
    const file = files[relativePath];
    if (!file) {
      throw new Error(`unexpected read of missing file: ${relativePath}`);
    }
    return file.body;
  };
  return { packageDir, exportsMap, readFile, statSize };
}

describe("findBuildOutputProblems", () => {
  it("returns no problems when every referenced dist file is present and complete", () => {
    expect(findBuildOutputProblems(buildFixture({}))).toEqual([]);
  });

  it("reports a missing declaration file", () => {
    const fixture = buildFixture({});
    const statSize = (path: string) =>
      path.endsWith("commands.d.ts") ? null : fixture.statSize(path);
    expect(findBuildOutputProblems({ ...fixture, statSize })).toContain(
      "dist/commands.d.ts: missing or empty"
    );
  });

  it("reports a zero-length declaration file", () => {
    expect(
      findBuildOutputProblems(
        buildFixture({ "dist/tokens.d.ts": { size: 0, body: "" } })
      )
    ).toContain("dist/tokens.d.ts: missing or empty");
  });

  it("reports a non-empty declaration file that has no exports", () => {
    expect(
      findBuildOutputProblems(
        buildFixture({
          "dist/tokens.d.ts": { size: 12, body: "// no types\n" },
        })
      )
    ).toContain(
      "dist/tokens.d.ts: declaration file has no exports (incomplete DTS)"
    );
  });

  it("reports a zero-length runtime file", () => {
    expect(
      findBuildOutputProblems(
        buildFixture({ "dist/commands.js": { size: 0, body: "" } })
      )
    ).toContain("dist/commands.js: missing or empty");
  });

  it("accumulates multiple problems across files", () => {
    const problems = findBuildOutputProblems(
      buildFixture({
        "dist/tokens.d.ts": { size: 0, body: "" },
        "dist/commands.cjs": { size: 0, body: "" },
      })
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        "dist/tokens.d.ts: missing or empty",
        "dist/commands.cjs: missing or empty",
      ])
    );
    expect(problems).toHaveLength(2);
  });

  it("traverses nested-condition exports entries instead of silently skipping them", () => {
    const nestedExportsMap = {
      "./nested": {
        import: { types: "./dist/nested.d.ts", default: "./dist/nested.js" },
        require: { types: "./dist/nested.d.cts", default: "./dist/nested.cjs" },
      },
    };
    const presentRelativePaths = new Set([
      "dist/nested.js",
      "dist/nested.cjs",
      "dist/nested.d.cts",
    ]);
    const packageDir = "/pkg";
    const problems = findBuildOutputProblems({
      packageDir,
      exportsMap: nestedExportsMap,
      statSize: (path: string) =>
        presentRelativePaths.has(path.slice(packageDir.length + 1)) ? 10 : null,
      readFile: () => "export {};\n",
    });
    // The nested `types` declaration is missing — the guard must report it, not
    // silently collect zero paths because the condition value is an object.
    expect(problems).toContain("dist/nested.d.ts: missing or empty");
  });
});

describe("findMissingExportProblems", () => {
  it("returns no problems when every source export is present in the declaration", () => {
    const expected = {
      "dist/commands.d.ts": ["LoopCommand", "LoopCommandSchema"],
    };
    const actual = {
      "dist/commands.d.ts": [
        "LoopCommand",
        "LoopCommandSchema",
        "RunLoopCommand",
      ],
    };
    expect(findMissingExportProblems(expected, actual)).toEqual([]);
  });

  it("reports a source export dropped from the declaration (partial DTS)", () => {
    const expected = {
      "dist/context-pack.d.ts": [
        "ContextPackAttachment",
        "ContextPackAttachmentSchema",
      ],
    };
    // tsup emitted the runtime schema const but silently dropped the type alias.
    const actual = {
      "dist/context-pack.d.ts": ["ContextPackAttachmentSchema"],
    };
    expect(findMissingExportProblems(expected, actual)).toEqual([
      "dist/context-pack.d.ts: declaration is missing exported member(s): ContextPackAttachment",
    ]);
  });

  it("lists every missing member, sorted, for a given entry", () => {
    const expected = {
      "dist/observability.d.ts": [
        "perfEventSchema",
        "RawPerfEvent",
        "createLoopRunEnvelope",
      ],
    };
    const actual = { "dist/observability.d.ts": ["perfEventSchema"] };
    expect(findMissingExportProblems(expected, actual)).toEqual([
      "dist/observability.d.ts: declaration is missing exported member(s): RawPerfEvent, createLoopRunEnvelope",
    ]);
  });

  it("treats a declaration with no resolved exports as missing everything", () => {
    const expected = { "dist/commands.d.ts": ["LoopCommand"] };
    expect(findMissingExportProblems(expected, {})).toEqual([
      "dist/commands.d.ts: declaration is missing exported member(s): LoopCommand",
    ]);
  });
});
