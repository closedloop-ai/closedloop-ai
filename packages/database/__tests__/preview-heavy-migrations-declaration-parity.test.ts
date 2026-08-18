import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type DeclaredExport,
  DeclaredShape,
  findDeclarationParityProblems,
  parseDeclaredExports,
  type RuntimeExport,
  toRuntimeExport,
} from "./test-helpers/declaration-parity";

/**
 * ISS-6211 — `preview-heavy-migrations-core.d.mts` restated the runtime
 * module's two migration lists as literal tuples, nothing checked the copy, and
 * it drifted: the declaration named 5 skip entries and 1 plain-build entry
 * while the `.mjs` had grown to 9 and 2.
 *
 * A declaration file is erased at runtime, so no behavior test could ever have
 * caught that. This suite closes it from the other side: it resolves the
 * declaration's AST (the mechanism AGENTS.md sanctions over a raw-text scan)
 * and compares it to the module actually imported at runtime.
 *
 * The comparator is driven against synthetic declarations too, so the guard's
 * own failure modes are proven rather than assumed — a parity test that only
 * ever sees an agreeing pair is exactly the vacuous green this ticket exists to
 * kill.
 */

const DECLARATION_PATH = fileURLToPath(
  new URL("../scripts/preview-heavy-migrations-core.d.mts", import.meta.url)
);

/**
 * The whole runtime export surface, loaded through a dynamic import so the
 * comparison sees EVERY export. A named import list would be a third
 * hand-maintained copy of the same surface, and an export it forgot to name is
 * precisely the drift this suite exists to catch.
 */
const previewHeavyMigrationsCore: Readonly<Record<string, unknown>> =
  await import("../scripts/preview-heavy-migrations-core.mjs");

/** The runtime module's exports, reduced to comparable string values. */
const RUNTIME_EXPORTS: readonly RuntimeExport[] = Object.entries(
  previewHeavyMigrationsCore
).map(([name, value]) => toRuntimeExport(name, value));

function declaredExportsOfShippedFile(): DeclaredExport[] {
  return parseDeclaredExports(
    readFileSync(DECLARATION_PATH, "utf8"),
    DECLARATION_PATH
  );
}

const NO_DECLARATIONS_PARSED_RE = /No exported value declarations were parsed/;

describe("preview-heavy-migrations-core declaration parity (shipped files)", () => {
  it("resolves every exported value declaration from the shipped .d.mts", () => {
    // Sanity: the AST walk actually found declarations, so an agreeing result
    // below cannot come from having parsed nothing.
    expect(
      declaredExportsOfShippedFile()
        .map((entry) => entry.name)
        .sort()
    ).toEqual(RUNTIME_EXPORTS.map((entry) => entry.name).sort());
  });

  it("declares the migration lists without restating their entries", () => {
    // The one owned source is the .mjs. A declaration that spells the entries
    // out is a second hand-maintained copy — the exact shape that drifted.
    const restating = declaredExportsOfShippedFile()
      .filter(
        (entry) => entry.restatesValues && entry.name.includes("MIGRATIONS")
      )
      .map((entry) => entry.name);
    expect(restating).toEqual([]);
  });

  it("agrees with the runtime module", () => {
    expect(
      findDeclarationParityProblems(
        declaredExportsOfShippedFile(),
        RUNTIME_EXPORTS
      )
    ).toEqual([]);
  });

  it("still restates the opt-out marker, and that literal matches the runtime value", () => {
    // A single scalar contract constant is worth pinning as a literal type; the
    // parity comparator is what keeps that pin honest.
    const marker = declaredExportsOfShippedFile().find(
      (entry) => entry.name === "PREVIEW_SKIP_OPT_OUT_MARKER"
    );
    expect(marker?.restatesValues).toBe(true);
    expect(marker?.literals).toEqual([
      previewHeavyMigrationsCore.PREVIEW_SKIP_OPT_OUT_MARKER,
    ]);
  });
});

describe("findDeclarationParityProblems (counterfactuals)", () => {
  // Built through `toRuntimeExport` rather than as literals: a hand-written
  // fixture would be a second copy of the runtime-export shape, and it would
  // stop exercising the reduction the production path actually runs.
  const runtime: readonly RuntimeExport[] = [
    toRuntimeExport("LIST", ["a", "b", "c"]),
    toRuntimeExport("MARKER", "preview-skip: no"),
    toRuntimeExport("check", (sql: string) => sql.length > 0),
  ];

  const DECLARED_SURFACE = `export const LIST: readonly string[];
export const MARKER: "preview-skip: no";
export function check(sql: string): boolean;`;

  it("reports nothing when a widened declaration matches the runtime surface", () => {
    const declared = parseDeclaredExports(
      `export const LIST: readonly string[];
export const MARKER: "preview-skip: no";
export function check(sql: string): boolean;`,
      "synthetic.d.mts"
    );
    expect(findDeclarationParityProblems(declared, runtime)).toEqual([]);
  });

  it("reports a restated tuple that has drifted from the runtime array", () => {
    // The shipped defect, reproduced: the declaration lags the runtime module.
    const declared = parseDeclaredExports(
      `export const LIST: readonly ["a", "b"];
export const MARKER: "preview-skip: no";
export function check(sql: string): boolean;`,
      "synthetic.d.mts"
    );
    const problems = findDeclarationParityProblems(declared, runtime);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"LIST"');
    expect(problems[0]).toContain('["a","b"]');
    expect(problems[0]).toContain('["a","b","c"]');
  });

  it.each([
    ['readonly ("a" | "b")[]', 'readonly ("a" | "b")[]'],
    ["ReadonlyArray<'a' | 'b'>", 'ReadonlyArray<"a" | "b">'],
    ["a bare union", '"a" | "b"'],
    ["a mutable literal array", '("a" | "b")[]'],
  ])("reports drift in %s, which spells values out without being a tuple", (_label, typeText) => {
    // Keying "does this restate values?" on `isTupleTypeNode` let every one of
    // these shapes drift in silence — a re-introduced declaration written any
    // of these ways would have passed both guards.
    const declared = parseDeclaredExports(
      `export const LIST: ${typeText};
export const MARKER: "preview-skip: no";
export function check(sql: string): boolean;`,
      "synthetic.d.mts"
    );
    const problems = findDeclarationParityProblems(declared, runtime);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"LIST"');
    expect(problems[0]).toContain('["a","b","c"]');
  });

  it.each([
    ["a backtick tuple", "readonly [`a`, `b`]"],
    ["a backtick union", "`a` | `b`"],
    ["a backtick scalar restated over MARKER", "readonly [`a`, `b`]"],
  ])("reports drift written with %s", (_label, typeText) => {
    // A backtick literal type parses as a NoSubstitutionTemplateLiteral, which
    // `ts.isStringLiteral` does not match. Collecting only `isStringLiteral`
    // made a copied tuple look widened, so it drifted unchecked.
    const declared = parseDeclaredExports(
      `export const LIST: ${typeText};
export const MARKER: "preview-skip: no";
export function check(sql: string): boolean;`,
      "synthetic.d.mts"
    );
    const problems = findDeclarationParityProblems(declared, runtime);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"LIST"');
    expect(problems[0]).toContain('["a","b"]');
    expect(problems[0]).toContain('["a","b","c"]');
  });

  it("accepts a backtick literal that matches the runtime value", () => {
    const declared = parseDeclaredExports(
      `export const LIST: readonly string[];
export const MARKER: \`preview-skip: no\`;
export function check(sql: string): boolean;`,
      "synthetic.d.mts"
    );
    expect(findDeclarationParityProblems(declared, runtime)).toEqual([]);
  });

  it("reports a template literal type with substitutions as unverifiable", () => {
    // `` `pack-${string}` `` restates no fixed value the comparator can compare,
    // so it fails closed rather than reading as a widened declaration.
    const declared = parseDeclaredExports(
      `export const LIST: readonly \`pack-\${string}\`[];
export const MARKER: "preview-skip: no";
export function check(sql: string): boolean;`,
      "synthetic.d.mts"
    );
    const problems = findDeclarationParityProblems(declared, runtime);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("cannot check any runtime value against");
  });

  it("reports drift hidden behind a local type alias", () => {
    // An alias puts the literals one name away from the declaration; without
    // expanding it the declaration reads as widened and nothing is compared.
    const declared = parseDeclaredExports(
      `type SkipList = readonly ["a", "b"];
export const LIST: SkipList;
export const MARKER: "preview-skip: no";
export function check(sql: string): boolean;`,
      "synthetic.d.mts"
    );
    const problems = findDeclarationParityProblems(declared, runtime);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"LIST"');
    expect(problems[0]).toContain('["a","b"]');
  });

  it("terminates on a self-referential type alias and reports it as unverifiable", () => {
    const declared = parseDeclaredExports(
      `type Loop = readonly [Loop];
export const LIST: Loop;
export const MARKER: "preview-skip: no";
export function check(sql: string): boolean;`,
      "synthetic.d.mts"
    );
    // Two things at once: the walk returns at all, and a type whose leaves
    // never resolve to strings is NOT silently accepted.
    const problems = findDeclarationParityProblems(declared, runtime);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"LIST"');
    expect(problems[0]).toContain("cannot check any runtime value against");
  });

  it("does not report a widening tuple as restating values it never spelled out", () => {
    // `readonly [string, ...string[]]` is a tuple but names no value, so
    // flagging it would be a false positive against a legitimate declaration.
    const declared = parseDeclaredExports(
      `export const LIST: readonly [string, ...string[]];
export const MARKER: "preview-skip: no";
export function check(sql: string): boolean;`,
      "synthetic.d.mts"
    );
    expect(findDeclarationParityProblems(declared, runtime)).toEqual([]);
  });

  it("reports a restated tuple whose entries are merely reordered", () => {
    const declared = parseDeclaredExports(
      `export const LIST: readonly ["a", "c", "b"];
export const MARKER: "preview-skip: no";
export function check(sql: string): boolean;`,
      "synthetic.d.mts"
    );
    expect(findDeclarationParityProblems(declared, runtime)).toHaveLength(1);
  });

  it("reports a drifted scalar literal", () => {
    const declared = parseDeclaredExports(
      `export const LIST: readonly string[];
export const MARKER: "preview-skip: yes";
export function check(sql: string): boolean;`,
      "synthetic.d.mts"
    );
    const problems = findDeclarationParityProblems(declared, runtime);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"MARKER"');
  });

  it("reports a runtime export the declaration never declares", () => {
    const declared = parseDeclaredExports(
      `export const LIST: readonly string[];
export const MARKER: "preview-skip: no";`,
      "synthetic.d.mts"
    );
    const problems = findDeclarationParityProblems(declared, runtime);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('exports "check"');
  });

  it("reports a declaration with no runtime export behind it", () => {
    const declared = parseDeclaredExports(
      `export const LIST: readonly string[];
export const MARKER: "preview-skip: no";
export const REMOVED: readonly string[];
export function check(sql: string): boolean;`,
      "synthetic.d.mts"
    );
    const problems = findDeclarationParityProblems(declared, runtime);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('declares "REMOVED"');
  });

  it("reports a literal restated over a runtime value it cannot describe", () => {
    const declared = parseDeclaredExports(
      `export const LIST: readonly string[];
export const MARKER: "preview-skip: no";
export const check: readonly ["a"];`,
      "synthetic.d.mts"
    );
    const problems = findDeclarationParityProblems(declared, runtime);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("cannot be verified");
  });

  it.each([
    ["an array carrying a number", ["a", 2]],
    ["an array carrying an object", ["a", {}]],
    ["an object", { a: "b" }],
    ["undefined", undefined],
    ["null", null],
  ])("reports a widened `readonly string[]` sitting over %s at runtime", (_label, runtimeValue) => {
    // The declaration restates nothing, so there are no literals to compare —
    // but `readonly string[]` is still a claim, and the runtime value does not
    // satisfy it. Reporting agreement here would hand every TypeScript
    // consumer a `string[]` contract the module does not honor.
    const declared = parseDeclaredExports(DECLARED_SURFACE, "synthetic.d.mts");
    const problems = findDeclarationParityProblems(declared, [
      toRuntimeExport("LIST", runtimeValue),
      toRuntimeExport("MARKER", "preview-skip: no"),
      toRuntimeExport("check", (sql: string) => sql.length > 0),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"LIST"');
    expect(problems[0]).toContain("cannot be verified");
  });

  it("reports a declared function whose runtime export is not callable", () => {
    const declared = parseDeclaredExports(DECLARED_SURFACE, "synthetic.d.mts");
    const problems = findDeclarationParityProblems(declared, [
      toRuntimeExport("LIST", ["a", "b", "c"]),
      toRuntimeExport("MARKER", "preview-skip: no"),
      toRuntimeExport("check", "not a function"),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"check"');
    expect(problems[0]).toContain("declares a function");
  });

  it("accepts a function declared as a const-typed signature when the runtime value is callable", () => {
    const declared = parseDeclaredExports(
      `export const LIST: readonly string[];
export const MARKER: "preview-skip: no";
export const check: (sql: string) => boolean;`,
      "synthetic.d.mts"
    );
    expect(findDeclarationParityProblems(declared, runtime)).toEqual([]);
  });

  it.each([
    "number",
    "readonly number[]",
    "unknown",
    "Record<string, string>",
  ])("reports `%s` as a declared type it cannot verify rather than passing it", (typeText) => {
    // Fail-closed: an unrecognized declared type is a claim the comparator
    // cannot check, not a claim that needs no checking.
    const declared = parseDeclaredExports(
      `export const LIST: ${typeText};
export const MARKER: "preview-skip: no";
export function check(sql: string): boolean;`,
      "synthetic.d.mts"
    );
    const problems = findDeclarationParityProblems(declared, runtime);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"LIST"');
    expect(problems[0]).toContain("cannot check any runtime value against");
  });

  it("classifies the declared surface it accepts, so agreement is not the absence of a verdict", () => {
    const declared = parseDeclaredExports(DECLARED_SURFACE, "synthetic.d.mts");
    expect(declared.map((entry) => [entry.name, entry.shape])).toEqual([
      ["LIST", DeclaredShape.StringValues],
      ["MARKER", DeclaredShape.StringValues],
      ["check", DeclaredShape.Function],
    ]);
  });

  it("throws rather than reporting agreement when the declaration parses to nothing", () => {
    // An emptied, renamed-to-types-only, or unparseable declaration must not
    // read as "no disagreements found" — that is a fail-open, not a pass.
    expect(() => findDeclarationParityProblems([], runtime)).toThrow(
      NO_DECLARATIONS_PARSED_RE
    );
  });

  it("parses nothing from a declaration stripped of its value exports", () => {
    expect(
      parseDeclaredExports(
        "export type Foo = string;\nconst hidden: readonly string[] = [];",
        "synthetic.d.mts"
      )
    ).toEqual([]);
  });
});
