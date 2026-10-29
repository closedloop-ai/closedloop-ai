import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importsOf,
  parseSourceFileAt,
  referencedIdentifierNamesIn,
  stringLiteralsIn,
} from "@repo/app/shared/testing/source-ast";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const AGENT_COMPONENTS_DIR = join(import.meta.dirname, "..", "..");
const OLD_APP_TABLE_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "apps",
  "app",
  "components",
  "agent-sessions",
  "synced-sessions-table.tsx"
);
const DETAIL_COMPONENTS_DIR = join(AGENT_COMPONENTS_DIR, "detail");
const AGENT_SLICE_DIR = join(AGENT_COMPONENTS_DIR, "..");
const AGENT_DATA_SOURCE_DIR = join(AGENT_SLICE_DIR, "data-source");
const AGENT_HOOKS_DIR = join(AGENT_SLICE_DIR, "hooks");
const OLD_APP_DETAIL_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "apps",
  "app",
  "components",
  "agent-session-detail-view.tsx"
);
const RETIRED_SESSIONS_LIST_PATH = join(
  import.meta.dirname,
  "..",
  "agent-sessions-list.tsx"
);
const RETIRED_SESSIONS_TABLE_PATH = join(
  import.meta.dirname,
  "..",
  "sessions-table.tsx"
);
// Markdown rendering must go through the sanctioned design-system
// `MarkdownContent` primitive (which safely wraps react-markdown), never a raw
// markdown library imported directly into these shared components. The two
// negative lookaheads allow that primitive and the slice-local `./trace-markdown`
// module while still blocking `react-markdown`, `markdown-to-jsx`, etc.
//
// The `desktop` alternative blocks pulling the desktop APP into shared code, but
// exempts `@repo/api/src/types/desktop-transcripts` — the shared FE+BE
// transcript read-path contract (FEA-2716/2717), whose module name merely
// contains "desktop". The lookahead is ANCHORED to that exact specifier prefix
// (not an unanchored `[^"']*desktop-transcripts` substring) so a main-process
// module like `apps/desktop/src/main/desktop-transcripts-client.ts` — whose path
// also contains the substring — is still caught. The sibling hook/data-source
// guardrail (`sharedSourceCouplingViolations`) already permits the contract (it
// targets `apps/desktop`), so this keeps the two rules consistent.
const FORBIDDEN_IMPORT_RE =
  /from\s+["'](?:next\/|@\/|apps\/app|@repo\/analytics|@repo\/auth|@repo\/collaboration|.*liveblocks|.*document-editor|.*document-table|(?!@repo\/design-system\/[^"']*markdown-content)(?!\.\/trace-markdown)[^"']*markdown|(?!@repo\/api\/src\/types\/desktop-transcripts)[^"']*desktop)/;
const FORBIDDEN_SCOPE_RE =
  /agent-sessions\/activity|useAgentSessionDetail|process\.env|from\s+["']@repo\/database|from\s+["']@repo\/observability|window\.desktopApi|globalThis\.desktopApi|shell\.openPath|openPlan|openFile|openPath|desktop:db|PlanRecord|PlanVersionRecord|WorkflowQueryData/;
// The shared data-source/hook coupling guard, asserted on the parsed AST rather
// than the file text (ISS-6926). The text scan this replaces matched PROSE: a
// docblock mentioning `desktop:db:changed` failed PR #5204 on a file whose
// imports were entirely clean, and the author reworded a comment to turn a
// required check green. Comments and identifiers are different node kinds to a
// parser, so the three sets below can only be tripped by real code.
const FORBIDDEN_SHARED_MODULE_PREFIXES = [
  "node:",
  "@repo/database",
  "@repo/observability",
] as const;
const FORBIDDEN_SHARED_MODULE_SPECIFIERS = new Set(["electron"]);
const DESKTOP_APP_MODULE_SEGMENT = "apps/desktop";
// `process` is forbidden outright, not just `process.env`: this package bundles
// to the browser, so any reference to the Node global is the same coupling.
const FORBIDDEN_SHARED_IDENTIFIERS = new Set([
  "contextBridge",
  "desktopApi",
  "ipcMain",
  "ipcRenderer",
  "process",
]);
// The desktop IPC channel namespace (`desktop:db:changed`), as a string VALUE.
const DESKTOP_CHANNEL_LITERAL_RE = /desktop:[A-Za-z]/;
const FORBIDDEN_DETAIL_CONTRACT_RE =
  /breadcrumbsHref|FeatureFlagged|\bHeader\b|useOrgSlug|useRouteParams/;
// The activity feed must not CONSTRUCT routes itself: no hardcoded `/sessions/`
// path literals and no route-prefix/document-path helpers. Route/href
// construction stays callback-owned (the injected `getSessionHref`), which keeps
// the shared slice surface-agnostic. Rendering a pre-built href through the
// `@repo/navigation` `Link` port is explicitly allowed (and required): FEA-4051
// swapped a raw `<a href>` for `Link` so the desktop renderer's hash-store
// adapter intercepts the click (a raw anchor was a dead click there), and the
// package's own hard-import rule already mandates `@repo/navigation` for Link.
// `Link` consumes an href the callback already built — it does not construct
// routes — so it is not part of this guardrail.
const FORBIDDEN_PACKAGE_ROUTE_RE =
  /["'`]\/(?:\$\{[^}]+\}\/)?sessions\/|buildScopedDocumentPath|getRoutePrefixForType/;
const MACHINE_SPECIFIC_ABSOLUTE_PATH_RE =
  /["'`]\/(?:Users|home)\/[^"'`]+\/(?:source|Source|repos?|workspace|code)\//;
const PATH_SEPARATOR_RE = /[\\/]/;
const TYPESCRIPT_SOURCE_RE = /\.(ts|tsx)$/;

describe("shared sessions list source guardrails", () => {
  it("keeps shared agent telemetry components free of app-only imports", () => {
    const violations = listProductionSourceFiles(AGENT_COMPONENTS_DIR)
      .map((filePath) => ({
        filePath,
        source: readFileSync(filePath, "utf8"),
      }))
      .filter(({ source }) => FORBIDDEN_IMPORT_RE.test(source));

    expect(violations).toEqual([]);
  });

  it("does not add forbidden endpoint, flag, env, database, detail, or desktop scope", () => {
    const violations = listProductionSourceFiles(AGENT_COMPONENTS_DIR)
      .map((filePath) => ({
        filePath,
        source: readFileSync(filePath, "utf8"),
      }))
      .filter(({ source }) => FORBIDDEN_SCOPE_RE.test(source));

    expect(violations).toEqual([]);
  });

  it("keeps package activity route construction callback-owned", () => {
    const routeSensitiveFiles = [
      join(AGENT_COMPONENTS_DIR, "activity"),
    ].flatMap(listProductionSourceFiles);
    const violations = routeSensitiveFiles
      .map((filePath) => ({
        filePath,
        source: readFileSync(filePath, "utf8"),
      }))
      .filter(({ source }) => FORBIDDEN_PACKAGE_ROUTE_RE.test(source));

    expect(violations).toEqual([]);
  });

  it("does not leave an app-local synced sessions table re-export shim", () => {
    expect(existsSync(OLD_APP_TABLE_PATH)).toBe(false);
  });

  it("keeps the retired Sessions v1 hosts absent after production adoption", () => {
    expect(existsSync(RETIRED_SESSIONS_LIST_PATH)).toBe(false);
    expect(existsSync(RETIRED_SESSIONS_TABLE_PATH)).toBe(false);
  });

  it("keeps shared detail source free of route chrome and app-owned contracts", () => {
    const violations = listProductionSourceFiles(DETAIL_COMPONENTS_DIR)
      .map((filePath) => ({
        filePath,
        source: readFileSync(filePath, "utf8"),
      }))
      .filter(({ source }) => FORBIDDEN_DETAIL_CONTRACT_RE.test(source));

    expect(violations).toEqual([]);
    expect(existsSync(OLD_APP_DETAIL_PATH)).toBe(false);
  });

  it("keeps shared agent component fixtures free of machine-specific absolute local paths", () => {
    const violations = listProductionSourceFiles(AGENT_COMPONENTS_DIR)
      .map((filePath) => ({
        filePath,
        source: readFileSync(filePath, "utf8"),
      }))
      .filter(({ filePath, source }) => {
        const fileName = filePath.split(PATH_SEPARATOR_RE).at(-1) ?? "";
        return (
          fileName.includes("fixture") &&
          MACHINE_SPECIFIC_ABSOLUTE_PATH_RE.test(source)
        );
      });

    expect(violations).toEqual([]);
  });

  it("keeps shared agent data-source and hook modules free of desktop, main, and node coupling", () => {
    const violations = [AGENT_DATA_SOURCE_DIR, AGENT_HOOKS_DIR]
      .flatMap(listProductionSourceFiles)
      .map((filePath) => ({
        couplings: sharedSourceCouplingViolations(filePath),
        filePath,
      }))
      .filter(({ couplings }) => couplings.length > 0);

    expect(violations).toEqual([]);
  });
});

/**
 * The DETECTOR, against synthetic modules (ISS-6926).
 *
 * Every case above scans today's production files, and all of them are clean —
 * so the suite passes whether `sharedSourceCouplingViolations` resolves the
 * couplings or resolves nothing at all, and a detector rewritten to return `[]`
 * unconditionally would keep it green. It also never exercises the behavior the
 * AST rewrite exists to buy: that a forbidden word in PROSE is not a violation.
 * A raw-text scan can come back, pass every case above, and reject a docblock
 * again (davetho).
 *
 * These four drive the same function over sources that place the forbidden
 * tokens in known positions, so the real-file cases sit on a detector proven to
 * fire — and proven not to fire on the two shapes that are not couplings.
 */
describe("sharedSourceCouplingViolations", () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "shared-source-coupling-"));
  });

  afterAll(() => {
    rmSync(workDir, { force: true, recursive: true });
  });

  it("names every coupling shape a module really declares", () => {
    const violations = sharedSourceCouplingViolations(
      writeCouplingModule(
        workDir,
        "real-coupling.ts",
        [
          'import { readFileSync } from "node:fs";',
          'import { ipcRenderer } from "electron";',
          'import { openPlan } from "apps/desktop/src/main/plans";',
          'const CHANNEL = "desktop:db:changed";',
          "const cwd = process.cwd();",
          "export const coupled = { CHANNEL, cwd, ipcRenderer, openPlan, readFileSync };",
        ].join("\n")
      )
    );

    expect(violations).toEqual([
      'import "node:fs"',
      'import "electron"',
      'import "apps/desktop/src/main/plans"',
      "identifier ipcRenderer",
      "identifier process",
      'desktop channel "desktop:db:changed"',
    ]);
  });

  it("does not flag the forbidden words when they appear only in prose", () => {
    const violations = sharedSourceCouplingViolations(
      writeCouplingModule(
        workDir,
        "prose-only.ts",
        [
          "/**",
          " * Mirrors the desktop main process: that side publishes on",
          " * `desktop:db:changed` after a write. This module must never import",
          " * node:fs or electron, and nothing under apps/desktop, because it",
          " * bundles to the browser — so it must not reach for process.env.",
          " */",
          "export const SHARED_CONTRACT_VERSION = 1;",
        ].join("\n")
      )
    );

    expect(violations).toEqual([]);
  });

  it("does not flag a member or type field named after a Node global", () => {
    const violations = sharedSourceCouplingViolations(
      writeCouplingModule(
        workDir,
        "member-names.ts",
        [
          "type SessionMetadata = { process: string };",
          "export const processNameOf = (metadata: SessionMetadata): string =>",
          "  metadata.process;",
        ].join("\n")
      )
    );

    expect(violations).toEqual([]);
  });

  it("rejects a computed module load, whose target no specifier check can resolve", () => {
    const violations = sharedSourceCouplingViolations(
      writeCouplingModule(
        workDir,
        "computed-load.ts",
        [
          'const moduleName = "node:fs";',
          "export const loaded = require(moduleName);",
        ].join("\n")
      )
    );

    expect(violations).toEqual(["computed module load moduleName"]);
  });
});

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return listSourceFiles(path);
    }
    return TYPESCRIPT_SOURCE_RE.test(path) ? [path] : [];
  });
}

function listProductionSourceFiles(dir: string): string[] {
  return listSourceFiles(dir).filter(
    (filePath) =>
      !(filePath.includes("__tests__") || filePath.endsWith(".stories.tsx"))
  );
}

/**
 * Every desktop/main/node coupling the module actually declares, each named so
 * a failure says WHICH specifier or identifier tripped it. Four shapes: a module
 * edge, a module edge whose target the source cannot resolve, a Node/Electron
 * global, and the desktop IPC channel namespace written as a string value.
 *
 * A COMPUTED edge is rejected outright rather than checked against the forbidden
 * list, because there is nothing to check it against: `SourceImport.specifier`
 * carries the EXPRESSION TEXT for those, so `const m = "node:fs"; require(m)`
 * presents `m` — which matches no prefix, passes the allow check, and creates
 * exactly the Node coupling this guard exists to block (davetho).
 *
 * Identifiers come from `referencedIdentifierNamesIn`, not the raw walk: the raw
 * one reports `process` for `metadata.process` and for `{ process: string }`,
 * which would fail a module with no Node global in play (whitlockk).
 */
function sharedSourceCouplingViolations(filePath: string): string[] {
  const sourceFile = parseSourceFileAt(filePath);
  const couplings = importsOf(sourceFile)
    .filter(
      (entry) => entry.computed || isForbiddenSharedModule(entry.specifier)
    )
    .map((entry) =>
      entry.computed
        ? `computed module load ${entry.specifier}`
        : `import "${entry.specifier}"`
    );

  couplings.push(
    ...referencedIdentifierNamesIn(sourceFile)
      .filter((name) => FORBIDDEN_SHARED_IDENTIFIERS.has(name))
      .map((name) => `identifier ${name}`),
    ...stringLiteralsIn(sourceFile)
      .filter((value) => DESKTOP_CHANNEL_LITERAL_RE.test(value))
      .map((value) => `desktop channel "${value}"`)
  );

  return [...new Set(couplings)];
}

/** Writes `source` into `dir` and returns its absolute path. */
function writeCouplingModule(
  dir: string,
  fileName: string,
  source: string
): string {
  const filePath = join(dir, fileName);
  writeFileSync(filePath, `${source}\n`, "utf8");
  return filePath;
}

function isForbiddenSharedModule(specifier: string): boolean {
  if (FORBIDDEN_SHARED_MODULE_SPECIFIERS.has(specifier)) {
    return true;
  }
  if (specifier.includes(DESKTOP_APP_MODULE_SEGMENT)) {
    return true;
  }
  return FORBIDDEN_SHARED_MODULE_PREFIXES.some((prefix) =>
    specifier.startsWith(prefix)
  );
}
