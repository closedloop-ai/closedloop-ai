import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  canonicalizeSpecifier,
  extractStoryComponentBinding,
  listStoryFiles,
  parseCliArgs,
  parseFile,
  parseLcov,
} from "../scripts/check-design-system-drift.mjs";

// In-process tests for FEA-1568 / PLN-867 additions to the design-system drift
// detector. Each block exercises one helper with a self-contained fixture so
// failures pinpoint the broken parser without depending on workspace state.

const PACKAGE_NAME = "@closedloop-ai/design-system";

type TestCtx = { after: (fn: () => void) => void };

function withTempFile(t: TestCtx, name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "ds-drift-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function withTempDir(t: TestCtx, name: string): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), `${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("parseCliArgs — defaults", () => {
  const args = parseCliArgs([]);
  assert.equal(args.emitJson, false);
  assert.equal(args.coverageLcov, null);
  // storybookDir defaults to a non-null absolute path
  assert.equal(typeof args.storybookDir, "string");
  assert.ok(path.isAbsolute(args.storybookDir));
});

test("parseCliArgs — recognizes flags in both forms", () => {
  const space = parseCliArgs([
    "--json",
    "--coverage-lcov",
    "/tmp/lcov.info",
    "--storybook-dir",
    "/tmp/stories",
  ]);
  assert.equal(space.emitJson, true);
  assert.equal(space.coverageLcov, "/tmp/lcov.info");
  // Absolute --storybook-dir is preserved unchanged.
  assert.equal(space.storybookDir, "/tmp/stories");

  const eq = parseCliArgs([
    "--json",
    "--coverage-lcov=/tmp/lcov.info",
    "--storybook-dir=/tmp/stories",
  ]);
  assert.equal(eq.coverageLcov, "/tmp/lcov.info");
  assert.equal(eq.storybookDir, "/tmp/stories");
});

test("parseCliArgs — relative --storybook-dir resolves against process.cwd()", () => {
  // Regression: a relative value used to flow through verbatim, producing
  // garbage `../../...` paths in the emitted report when the CI invocation
  // passes a relative arg.
  const args = parseCliArgs(["--storybook-dir", "rel/stories"]);
  assert.equal(path.isAbsolute(args.storybookDir), true);
  assert.equal(args.storybookDir, path.resolve(process.cwd(), "rel/stories"));

  const eq = parseCliArgs(["--storybook-dir=rel/stories"]);
  assert.equal(path.isAbsolute(eq.storybookDir), true);
  assert.equal(eq.storybookDir, path.resolve(process.cwd(), "rel/stories"));
});

test("canonicalizeSpecifier — @repo alias mapped to @closedloop-ai", () => {
  assert.equal(canonicalizeSpecifier("@repo/design-system"), PACKAGE_NAME);
  assert.equal(
    canonicalizeSpecifier("@repo/design-system/components/ui/button"),
    `${PACKAGE_NAME}/components/ui/button`
  );
  // Pass-through for canonical and unrelated specifiers
  assert.equal(canonicalizeSpecifier(PACKAGE_NAME), PACKAGE_NAME);
  assert.equal(
    canonicalizeSpecifier(`${PACKAGE_NAME}/components/ui/button`),
    `${PACKAGE_NAME}/components/ui/button`
  );
  assert.equal(canonicalizeSpecifier("react"), "react");
});

test("parseLcov — empty file yields empty exercised set", (t) => {
  const filePath = withTempFile(t, "empty.lcov", "");
  const { exercisedFiles, allFiles } = parseLcov(filePath);
  assert.equal(exercisedFiles.size, 0);
  assert.equal(allFiles.size, 0);
});

test("parseLcov — single record with executed line", (t) => {
  const fixtureDir = withTempDir(t, "ds-drift-lcov");
  const lcov = [
    "TN:",
    "SF:src/main/foo.ts",
    "DA:1,0",
    "DA:2,5",
    "DA:3,0",
    "end_of_record",
  ].join("\n");
  const filePath = path.join(fixtureDir, "lcov.info");
  fs.writeFileSync(filePath, lcov);
  const { exercisedFiles, allFiles } = parseLcov(filePath);
  const expected = path.resolve(fixtureDir, "src/main/foo.ts");
  assert.equal(allFiles.has(expected), true);
  assert.equal(exercisedFiles.has(expected), true);
});

test("parseLcov — record with no executed lines is not exercised", (t) => {
  const fixtureDir = withTempDir(t, "ds-drift-lcov-cold");
  const lcov = [
    "TN:",
    "SF:src/main/cold.ts",
    "DA:1,0",
    "DA:2,0",
    "FNDA:0,handler",
    "end_of_record",
  ].join("\n");
  const filePath = path.join(fixtureDir, "lcov.info");
  fs.writeFileSync(filePath, lcov);
  const { exercisedFiles, allFiles } = parseLcov(filePath);
  const expected = path.resolve(fixtureDir, "src/main/cold.ts");
  assert.equal(allFiles.has(expected), true);
  assert.equal(exercisedFiles.has(expected), false);
});

test("parseLcov — FNDA hit alone marks file exercised", (t) => {
  const fixtureDir = withTempDir(t, "ds-drift-lcov-fnda");
  const lcov = [
    "TN:",
    "SF:src/main/fnda-only.ts",
    "FN:1,handler",
    "FNDA:3,handler",
    "end_of_record",
  ].join("\n");
  const filePath = path.join(fixtureDir, "lcov.info");
  fs.writeFileSync(filePath, lcov);
  const { exercisedFiles } = parseLcov(filePath);
  const expected = path.resolve(fixtureDir, "src/main/fnda-only.ts");
  assert.equal(exercisedFiles.has(expected), true);
});

test("parseLcov — multi-record file separates exercised from cold", (t) => {
  const fixtureDir = withTempDir(t, "ds-drift-lcov-multi");
  const lcov = [
    "TN:",
    "SF:src/main/hot.ts",
    "DA:1,10",
    "end_of_record",
    "TN:",
    "SF:src/main/cold.ts",
    "DA:1,0",
    "end_of_record",
    "TN:",
    "SF:src/renderer/app.tsx",
    "DA:1,1",
    "end_of_record",
  ].join("\n");
  const filePath = path.join(fixtureDir, "lcov.info");
  fs.writeFileSync(filePath, lcov);
  const { exercisedFiles, allFiles } = parseLcov(filePath);
  assert.equal(allFiles.size, 3);
  assert.equal(exercisedFiles.size, 2);
  assert.equal(
    exercisedFiles.has(path.resolve(fixtureDir, "src/main/hot.ts")),
    true
  );
  assert.equal(
    exercisedFiles.has(path.resolve(fixtureDir, "src/main/cold.ts")),
    false
  );
  assert.equal(
    exercisedFiles.has(path.resolve(fixtureDir, "src/renderer/app.tsx")),
    true
  );
});

test("parseLcov — flushes a trailing record without end_of_record", (t) => {
  // Some LCOV writers omit end_of_record after the final SF block. The parser
  // should still attribute the trailing file's exercised status.
  const fixtureDir = withTempDir(t, "ds-drift-lcov-trailing");
  const lcov = ["TN:", "SF:src/main/trailing.ts", "DA:1,7"].join("\n");
  const filePath = path.join(fixtureDir, "lcov.info");
  fs.writeFileSync(filePath, lcov);
  const { exercisedFiles } = parseLcov(filePath);
  const expected = path.resolve(fixtureDir, "src/main/trailing.ts");
  assert.equal(exercisedFiles.has(expected), true);
});

test("parseLcov — coverage/ subdir lifts SF: paths up to its parent (test-runner cwd)", (t) => {
  // Regression test for the production layout: Node's --test-reporter=lcov
  // writes coverage/lcov.info with SF: paths relative to the test runner's
  // cwd (apps/desktop), not to coverage/. If parseLcov resolved SF: against
  // the lcov file's own directory we would mis-map every entry into a
  // phantom apps/desktop/coverage/src/... path, breaking the cross-reference.
  const root = withTempDir(t, "ds-drift-lcov-coverage-subdir");
  const coverageDir = path.join(root, "coverage");
  fs.mkdirSync(coverageDir);
  const lcov = ["TN:", "SF:src/main/foo.ts", "DA:1,3", "end_of_record"].join(
    "\n"
  );
  const lcovPath = path.join(coverageDir, "lcov.info");
  fs.writeFileSync(lcovPath, lcov);
  const { exercisedFiles } = parseLcov(lcovPath);
  // Resolves against `root`, NOT `root/coverage`.
  const expected = path.join(root, "src", "main", "foo.ts");
  assert.equal(exercisedFiles.has(expected), true);
  assert.equal(
    exercisedFiles.has(path.join(coverageDir, "src", "main", "foo.ts")),
    false
  );
});

test("parseLcov — handles CRLF line endings", (t) => {
  // A `\r` snuck into the line slice would defeat the `=== "end_of_record"`
  // check and leak `currentExercised` state across SF: boundaries.
  const fixtureDir = withTempDir(t, "ds-drift-lcov-crlf");
  const lcov = [
    "TN:",
    "SF:src/main/crlf-hot.ts",
    "DA:1,1",
    "end_of_record",
    "TN:",
    "SF:src/main/crlf-cold.ts",
    "DA:1,0",
    "end_of_record",
  ].join("\r\n");
  const filePath = path.join(fixtureDir, "lcov.info");
  fs.writeFileSync(filePath, lcov);
  const { exercisedFiles } = parseLcov(filePath);
  assert.equal(
    exercisedFiles.has(path.resolve(fixtureDir, "src/main/crlf-hot.ts")),
    true
  );
  // The cold record must NOT inherit the previous record's exercised state.
  assert.equal(
    exercisedFiles.has(path.resolve(fixtureDir, "src/main/crlf-cold.ts")),
    false
  );
});

test("extractStoryComponentBinding — meta + satisfies pattern (canonical Storybook shape)", (t) => {
  const filePath = withTempFile(
    t,
    "button.stories.tsx",
    [
      'import { Button } from "@repo/design-system/components/ui/button";',
      'import type { Meta, StoryObj } from "@storybook/react";',
      "",
      "const meta = {",
      '  title: "Design System/Primitives/Button",',
      "  component: Button,",
      "} satisfies Meta<typeof Button>;",
      "",
      "export default meta;",
      "",
      "type Story = StoryObj<typeof meta>;",
      "export const Default: Story = {};",
    ].join("\n")
  );
  const sourceFile = parseFile(filePath);
  const binding = extractStoryComponentBinding(sourceFile);
  assert.deepEqual(binding, {
    component: "Button",
    specifier: `${PACKAGE_NAME}/components/ui/button`,
  });
});

test("extractStoryComponentBinding — inline default-export object", (t) => {
  const filePath = withTempFile(
    t,
    "badge.stories.tsx",
    [
      'import { Badge } from "@repo/design-system/components/ui/badge";',
      "",
      "export default {",
      "  component: Badge,",
      "};",
    ].join("\n")
  );
  const sourceFile = parseFile(filePath);
  const binding = extractStoryComponentBinding(sourceFile);
  assert.deepEqual(binding, {
    component: "Badge",
    specifier: `${PACKAGE_NAME}/components/ui/badge`,
  });
});

test("extractStoryComponentBinding — `import { X as Y }` resolves to origin name", (t) => {
  const filePath = withTempFile(
    t,
    "aliased.stories.tsx",
    [
      'import { Button as PrimaryButton } from "@repo/design-system/components/ui/button";',
      "",
      "const meta = {",
      "  component: PrimaryButton,",
      "} satisfies Meta<typeof PrimaryButton>;",
      "",
      "export default meta;",
    ].join("\n")
  );
  const sourceFile = parseFile(filePath);
  const binding = extractStoryComponentBinding(sourceFile);
  // The detector reports the ORIGIN export name ("Button") so cross-references
  // against renderer imports (which import "Button") match.
  assert.deepEqual(binding, {
    component: "Button",
    specifier: `${PACKAGE_NAME}/components/ui/button`,
  });
});

test("extractStoryComponentBinding — design-system import alongside unrelated imports", (t) => {
  // A real story file pulls helpers from many packages. The binding scan
  // must keep the design-system attribution intact regardless of import order.
  const filePath = withTempFile(
    t,
    "mixed.stories.tsx",
    [
      'import { useState } from "react";',
      'import { Mail } from "lucide-react";',
      'import { Button } from "@repo/design-system/components/ui/button";',
      'import type { Meta } from "@storybook/react";',
      "",
      "const meta = {",
      "  component: Button,",
      "} satisfies Meta<typeof Button>;",
      "",
      "export default meta;",
    ].join("\n")
  );
  const sourceFile = parseFile(filePath);
  const binding = extractStoryComponentBinding(sourceFile);
  assert.deepEqual(binding, {
    component: "Button",
    specifier: `${PACKAGE_NAME}/components/ui/button`,
  });
});

test("extractStoryComponentBinding — type-only import does not shadow value import", (t) => {
  // `import type { Button } from '<some-other-package>'` must not clobber a
  // real value `import { Button } from '@repo/design-system/...'` regardless
  // of order. Type-only imports are erased at runtime and could otherwise
  // mis-attribute the story to a phantom specifier.
  const filePath = withTempFile(
    t,
    "type-only.stories.tsx",
    [
      'import type { Button } from "some-types-only-pkg";',
      'import { Button as ValueButton } from "@repo/design-system/components/ui/button";',
      "",
      "const meta = {",
      "  component: ValueButton,",
      "};",
      "export default meta;",
    ].join("\n")
  );
  const sourceFile = parseFile(filePath);
  const binding = extractStoryComponentBinding(sourceFile);
  assert.deepEqual(binding, {
    component: "Button",
    specifier: `${PACKAGE_NAME}/components/ui/button`,
  });
});

test("extractStoryComponentBinding — no meta returns null (safe degradation)", (t) => {
  const filePath = withTempFile(
    t,
    "stub.stories.tsx",
    [
      'import { Thing } from "@repo/design-system/lib/thing";',
      "// no default export",
    ].join("\n")
  );
  const sourceFile = parseFile(filePath);
  const binding = extractStoryComponentBinding(sourceFile);
  assert.equal(binding, null);
});

test("extractStoryComponentBinding — non-imported component is ignored", (t) => {
  // If `component:` references a local identifier (e.g. a wrapper defined in
  // the story file), there is no design-system import to attribute it to.
  // Returning null avoids false positives in the cross-reference step.
  const filePath = withTempFile(
    t,
    "local.stories.tsx",
    [
      "function LocalThing() { return null; }",
      "",
      "const meta = {",
      "  component: LocalThing,",
      "};",
      "export default meta;",
    ].join("\n")
  );
  const sourceFile = parseFile(filePath);
  const binding = extractStoryComponentBinding(sourceFile);
  assert.equal(binding, null);
});

test("listStoryFiles — recurses into subdirectories", (t) => {
  // Regression test for the PR-1514 review finding: a flat-only scan would
  // silently drop stories that a future re-organization moves under
  // per-component-family subdirs.
  const root = withTempDir(t, "ds-drift-stories-recursive");
  fs.writeFileSync(path.join(root, "flat.stories.tsx"), "// flat");
  const sub = path.join(root, "forms");
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, "input.stories.tsx"), "// nested");
  fs.writeFileSync(path.join(sub, "not-a-story.tsx"), "// excluded");
  const nested = path.join(sub, "advanced");
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, "select.stories.tsx"), "// deep");

  const files = listStoryFiles(root).sort();
  assert.deepEqual(files, [
    path.join(root, "flat.stories.tsx"),
    path.join(sub, "advanced", "select.stories.tsx"),
    path.join(sub, "input.stories.tsx"),
  ]);
});

test("listStoryFiles — returns [] for a missing directory", () => {
  const files = listStoryFiles(
    path.join(tmpdir(), "ds-drift-does-not-exist-XYZ")
  );
  assert.deepEqual(files, []);
});
