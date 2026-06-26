import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SIDEBAR_SEARCH_FORM_PATH = join(
  import.meta.dirname,
  "..",
  "sidebar-search-form.tsx"
);
const PLAN_FORBIDDEN_SOURCE_RE =
  /@repo\/navigation|next\/navigation|useOrgSlug|\borgSlug\b|URLSearchParams|useSearchParamsValue|\bNavId\b|hrefForNavId|buildSessionsSearchHref|\bdesktopApi\b|window\.location|\btagId\b|["'`]q["'`]|\/my-tasks|\/sessions/;
const SHARED_PACKAGE_FORBIDDEN_SOURCE_RE =
  /from\s+["']@\/|from\s+["'][^"']*apps\/app|from\s+["'][^"']*apps\/desktop|from\s+["']node:|from\s+["']electron["']|\bipcRenderer\b|\bipcMain\b|\bcontextBridge\b|process\.env|from\s+["']@repo\/database|from\s+["']@repo\/observability|window\.desktopApi|globalThis\.desktopApi|desktop:[A-Za-z]|shell\.openPath|openFile|openPath/;
const ROUTE_CONSTRUCTION_SENSITIVE_RE =
  /new URL\(|URLSearchParams|location\.hash|location\.pathname|router\.|navigate\(|replace\(|push\(|hrefFor|route|pathname|searchParams/;

describe("SidebarSearchForm source ownership", () => {
  it("keeps route, org, query-param, and desktop ownership out of shared UI", () => {
    const source = readFileSync(SIDEBAR_SEARCH_FORM_PATH, "utf8");

    expect(source).not.toMatch(PLAN_FORBIDDEN_SOURCE_RE);
  });

  it("keeps shared search chrome free of app-only, desktop, Node, env, database, and observability coupling", () => {
    const source = readFileSync(SIDEBAR_SEARCH_FORM_PATH, "utf8");

    expect(source).not.toMatch(SHARED_PACKAGE_FORBIDDEN_SOURCE_RE);
  });

  it("keeps route construction and URL source reads callback-owned by adapters", () => {
    const source = readFileSync(SIDEBAR_SEARCH_FORM_PATH, "utf8");

    expect(source).not.toMatch(ROUTE_CONSTRUCTION_SENSITIVE_RE);
  });
});
