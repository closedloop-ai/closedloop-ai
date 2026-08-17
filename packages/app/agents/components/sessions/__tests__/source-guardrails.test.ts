import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  importsOf,
  parseSourceFileAt,
  type SourceImport,
} from "@repo/app/shared/testing/source-ast";
import { describe, expect, it } from "vitest";

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
const DERIVED_COMPONENTS_DIR = join(AGENT_COMPONENTS_DIR, "derived");
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
// guardrail (`FORBIDDEN_SHARED_SOURCE_RE`) already permits the contract (it
// targets `apps/desktop`), so this keeps the two rules consistent.
const FORBIDDEN_IMPORT_RE =
  /from\s+["'](?:next\/|@\/|apps\/app|@repo\/analytics|@repo\/auth|@repo\/collaboration|.*liveblocks|.*document-editor|.*document-table|(?!@repo\/design-system\/[^"']*markdown-content)(?!\.\/trace-markdown)[^"']*markdown|(?!@repo\/api\/src\/types\/desktop-transcripts)[^"']*desktop)/;
const FORBIDDEN_SCOPE_RE =
  /agent-sessions\/activity|useAgentSessionDetail|DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY|process\.env|from\s+["']@repo\/database|from\s+["']@repo\/observability|window\.desktopApi|globalThis\.desktopApi|shell\.openPath|openPlan|openFile|openPath|desktop:db|PlanRecord|PlanVersionRecord|WorkflowQueryData/;
const FORBIDDEN_SHARED_SOURCE_RE =
  /window\.desktopApi|globalThis\.desktopApi|desktop:[A-Za-z]|from\s+["'][^"']*apps\/desktop|from\s+["']node:|from\s+["']electron["']|\bipcRenderer\b|\bipcMain\b|\bcontextBridge\b|process\.env|from\s+["']@repo\/database|from\s+["']@repo\/observability/;
const FORBIDDEN_DETAIL_CONTRACT_RE =
  /breadcrumbsHref|FeatureFlagged|DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY|\bHeader\b|useOrgSlug|useRouteParams/;
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
// Project and team metadata are owned by their own slices; the analytics view
// consumes them through those slices' hooks rather than re-deriving either.
// The durable contract is the import edge itself, so it is asserted on the
// parsed AST (FEA-4112) — an explanatory comment beside the import is prose a
// guard cannot depend on.
const PROJECTS_HOOK_MODULE = "../../../projects/hooks/use-projects";
const TEAMS_HOOK_MODULE = "../../../teams/hooks/use-teams";
const TYPESCRIPT_SOURCE_RE = /\.(ts|tsx)$/;
const DETAIL_OWNED_ANALYTICS_MODULES = new Set([
  "agent-tree-utils.ts",
  "agent-orchestration-graph.tsx",
  "tool-execution-flow.tsx",
  "subagent-effectiveness-panel.tsx",
  "error-propagation-map.tsx",
]);

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

  it("imports analytics cross-slice metadata from the owning slices", () => {
    const imports = importsOf(
      parseSourceFileAt(
        join(AGENT_COMPONENTS_DIR, "analytics", "agent-telemetry-analytics.tsx")
      )
    );

    expect(namesImportedFrom(imports, PROJECTS_HOOK_MODULE)).toContain(
      "useProjects"
    );
    expect(namesImportedFrom(imports, TEAMS_HOOK_MODULE)).toContain("useTeams");
  });

  it("does not leave an app-local synced sessions table re-export shim", () => {
    expect(existsSync(OLD_APP_TABLE_PATH)).toBe(false);
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
        filePath,
        source: readFileSync(filePath, "utf8"),
      }))
      .filter(({ source }) => FORBIDDEN_SHARED_SOURCE_RE.test(source));

    expect(violations).toEqual([]);
  });

  it("keeps derived views from duplicating detail-owned analytics modules", () => {
    const violations = listProductionSourceFiles(DERIVED_COMPONENTS_DIR).filter(
      (filePath) => {
        const fileName = filePath.split(PATH_SEPARATOR_RE).at(-1) ?? "";
        return DETAIL_OWNED_ANALYTICS_MODULES.has(fileName);
      }
    );

    expect(violations).toEqual([]);
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

function namesImportedFrom(
  imports: readonly SourceImport[],
  specifier: string
): string[] {
  return imports
    .filter((entry) => entry.specifier === specifier)
    .flatMap((entry) => entry.names);
}
