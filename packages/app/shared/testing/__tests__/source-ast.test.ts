import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  identifierNamesIn,
  importsOf,
  parseSourceFileAt,
  referencedIdentifierNamesIn,
} from "@repo/app/shared/testing/source-ast";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `importsOf` is the primitive under every "module X must not import Y" and
 * "module X declares no edges at all" guard in this package. A load form it
 * drops is a guard that passes on a module that broke the invariant, so the
 * edge-detection contract is pinned here rather than only inside the guards
 * that depend on it (whitlockk review on PR #5130).
 */

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "source-ast-"));
});

afterAll(() => {
  rmSync(workDir, { force: true, recursive: true });
});

describe("importsOf", () => {
  it("reports literal static, re-export, dynamic, and require specifiers by value", () => {
    const edges = importsOf(
      parseSourceFileAt(
        writeModule(
          "literal-edges.ts",
          [
            'import { a as renamed } from "./static";',
            'export { b } from "./re-export";',
            'const dynamic = () => import("./dynamic");',
            'const required = require("./required");',
          ].join("\n")
        )
      )
    );

    expect(edges).toEqual([
      { computed: false, names: ["a"], specifier: "./static" },
      { computed: false, names: [], specifier: "./re-export" },
      { computed: false, names: [], specifier: "./dynamic" },
      { computed: false, names: [], specifier: "./required" },
    ]);
  });

  it("reports a computed dynamic import as an edge, so a no-edges guard cannot be sidestepped by not writing a literal", () => {
    const edges = importsOf(
      parseSourceFileAt(
        writeModule(
          "computed-import.ts",
          [
            'const moduleName = "@repo/design-system/components/ui/skeleton";',
            "const load = () => import(moduleName);",
          ].join("\n")
        )
      )
    );

    expect(edges).toEqual([
      { computed: true, names: [], specifier: "moduleName" },
    ]);
  });

  it("reports a computed require as an edge", () => {
    const edges = importsOf(
      parseSourceFileAt(
        writeModule(
          "computed-require.ts",
          [
            'const moduleName = "node:fs";',
            "const loaded = require(moduleName);",
          ].join("\n")
        )
      )
    );

    expect(edges).toEqual([
      { computed: true, names: [], specifier: "moduleName" },
    ]);
  });

  it("reports a concatenated specifier as an edge", () => {
    const edges = importsOf(
      parseSourceFileAt(
        writeModule(
          "concatenated-import.ts",
          [
            'const slice = "sessions";',
            'const load = () => import("./" + slice);',
          ].join("\n")
        )
      )
    );

    expect(edges).toEqual([
      { computed: true, names: [], specifier: '"./" + slice' },
    ]);
  });

  it("resolves a substitution-free template specifier to its value", () => {
    const edges = importsOf(
      parseSourceFileAt(
        writeModule(
          "template-import.ts",
          "const load = () => import(`./templated`);"
        )
      )
    );

    expect(edges).toEqual([
      { computed: false, names: [], specifier: "./templated" },
    ]);
  });

  it("treats a specifier-less export as no edge at all", () => {
    const edges = importsOf(
      parseSourceFileAt(
        writeModule(
          "no-edges.ts",
          ["const value = 1;", "export { value };"].join("\n")
        )
      )
    );

    expect(edges).toEqual([]);
  });
});

/**
 * `referencedIdentifierNamesIn` is the primitive under every "this module must
 * not touch global X" guard. Over-reporting is as damaging as under-reporting
 * there: a guard that fails a module for writing `metadata.process` teaches its
 * author to reword rather than to fix, which is the same failure the AST scan
 * replaced a text scan to end (whitlockk review on PR #7206).
 */
describe("referencedIdentifierNamesIn", () => {
  it("keeps the object of a property access and drops the member name", () => {
    const sourceFile = parseSourceFileAt(
      writeModule("property-access.ts", "const mode = process.env.NODE_ENV;")
    );

    expect(referencedIdentifierNamesIn(sourceFile)).toEqual([
      "mode",
      "process",
    ]);
    // The contrast that makes the narrower collector worth having: the raw walk
    // cannot tell `process.env` from an `env` member of anything else.
    expect(identifierNamesIn(sourceFile)).toContain("env");
  });

  it("drops a property and a type field named after a global", () => {
    expect(
      referencedIdentifierNamesIn(
        parseSourceFileAt(
          writeModule(
            "member-collision.ts",
            [
              "type Metadata = { process: string };",
              "const read = (metadata: Metadata) => metadata.process;",
            ].join("\n")
          )
        )
      )
    ).not.toContain("process");
  });

  it("keeps a shorthand property, where the one identifier is also the reference", () => {
    expect(
      referencedIdentifierNamesIn(
        parseSourceFileAt(
          writeModule(
            "shorthand-property.ts",
            [
              "const process = globalThis.process;",
              "export const bundle = { process };",
            ].join("\n")
          )
        )
      )
    ).toContain("process");
  });

  it("keeps an identifier in a computed key, where the brackets make it a read of the binding", () => {
    expect(
      referencedIdentifierNamesIn(
        parseSourceFileAt(
          writeModule(
            "computed-key-identifier.ts",
            [
              "const value = 1;",
              "export const bundle = { [process]: value };",
            ].join("\n")
          )
        )
      )
    ).toContain("process");
  });

  it("keeps the object of a property-access computed key and drops its member name", () => {
    const names = referencedIdentifierNamesIn(
      parseSourceFileAt(
        writeModule(
          "computed-key-property-access.ts",
          "export const bundle = { [process.env]: 1 };"
        )
      )
    );

    expect(names).toContain("process");
    expect(names).not.toContain("env");
  });

  it("keeps an identifier in a computed METHOD name, not only a computed property key", () => {
    expect(
      referencedIdentifierNamesIn(
        parseSourceFileAt(
          writeModule(
            "computed-method-name.ts",
            ["export class Bundle {", "  [process]() {}", "}"].join("\n")
          )
        )
      )
    ).toContain("process");
  });

  it("reports no reference for a LITERAL computed key, which names a member rather than reading a binding", () => {
    expect(
      referencedIdentifierNamesIn(
        parseSourceFileAt(
          writeModule(
            "computed-key-literal.ts",
            'export const bundle = { ["process"]: 1, [0]: 2 };'
          )
        )
      )
    ).not.toContain("process");
  });
});

/** Writes `source` into the suite's scratch dir and returns its absolute path. */
function writeModule(fileName: string, source: string): string {
  const filePath = join(workDir, fileName);
  writeFileSync(filePath, `${source}\n`, "utf8");
  return filePath;
}
