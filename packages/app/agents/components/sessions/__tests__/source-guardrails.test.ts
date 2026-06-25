import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
const FORBIDDEN_IMPORT_RE =
  /from\s+["'](?:next\/|@\/|apps\/app|@repo\/analytics|@repo\/auth|@repo\/collaboration|.*liveblocks|.*document-editor|.*document-table|(?!@repo\/design-system\/[^"']*markdown-content)(?!\.\/trace-markdown)[^"']*markdown|.*desktop)/;
const FORBIDDEN_SCOPE_RE =
  /agent-sessions\/(?:activity|kanban)|useAgentSessionDetail|DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY|process\.env|from\s+["']@repo\/database|from\s+["']@repo\/observability|window\.desktopApi|globalThis\.desktopApi|shell\.openPath|openPlan|openFile|openPath|desktop:db|PlanRecord|PlanVersionRecord|WorkflowQueryData/;
const FORBIDDEN_SHARED_SOURCE_RE =
  /window\.desktopApi|globalThis\.desktopApi|desktop:[A-Za-z]|from\s+["'][^"']*apps\/desktop|from\s+["']node:|from\s+["']electron["']|\bipcRenderer\b|\bipcMain\b|\bcontextBridge\b|process\.env|from\s+["']@repo\/database|from\s+["']@repo\/observability/;
const FORBIDDEN_DETAIL_CONTRACT_RE =
  /breadcrumbsHref|FeatureFlagged|DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY|\bHeader\b|useOrgSlug|useRouteParams/;
const FORBIDDEN_PACKAGE_ROUTE_RE =
  /["'`]\/(?:\$\{[^}]+\}\/)?sessions\/|buildScopedDocumentPath|getRoutePrefixForType|@repo\/navigation\/link/;
const MACHINE_SPECIFIC_ABSOLUTE_PATH_RE =
  /["'`]\/(?:Users|home)\/[^"'`]+\/(?:source|Source|repos?|workspace|code)\//;
const PATH_SEPARATOR_RE = /[\\/]/;
const PROJECTS_IMPORT_COMMENT_RE =
  /Projects owns project metadata;[\s\S]*import \{ useProjects \} from "\.\.\/\.\.\/\.\.\/projects\/hooks\/use-projects";/;
const TEAMS_IMPORT_COMMENT_RE =
  /Teams owns team metadata;[\s\S]*import \{ useTeams \} from "\.\.\/\.\.\/\.\.\/teams\/hooks\/use-teams";/;
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

  it("keeps package activity and kanban route construction callback-owned", () => {
    const routeSensitiveFiles = [
      join(AGENT_COMPONENTS_DIR, "activity"),
      join(AGENT_COMPONENTS_DIR, "kanban"),
    ].flatMap(listProductionSourceFiles);
    const violations = routeSensitiveFiles
      .map((filePath) => ({
        filePath,
        source: readFileSync(filePath, "utf8"),
      }))
      .filter(({ source }) => FORBIDDEN_PACKAGE_ROUTE_RE.test(source));

    expect(violations).toEqual([]);
  });

  it("documents analytics cross-slice metadata imports at the import site", () => {
    const source = readFileSync(
      join(AGENT_COMPONENTS_DIR, "analytics", "agent-telemetry-analytics.tsx"),
      "utf8"
    );

    expect(source).toMatch(PROJECTS_IMPORT_COMMENT_RE);
    expect(source).toMatch(TEAMS_IMPORT_COMMENT_RE);
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
