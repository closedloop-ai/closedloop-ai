/**
 * Structural ownership guard for the shared sidebar search chrome.
 *
 * AST-based (FEA-4112): the file is parsed and the assertions run over its
 * resolved import specifiers, identifiers, and string-literal values — never
 * over the raw source text. That makes the guard immune to comments (a mention
 * of `next/navigation` in a doc block is not a violation) and to reformatting,
 * and it stops unrelated substrings from tripping a route token.
 */
import { join } from "node:path";
import {
  identifierNamesIn,
  importsOf,
  parseSourceFileAt,
  stringLiteralsIn,
} from "@repo/app/shared/testing/source-ast";
import { describe, expect, it } from "vitest";

const SIDEBAR_SEARCH_FORM_PATH = join(
  import.meta.dirname,
  "..",
  "sidebar-search-form.tsx"
);

// Route/org/query-param ownership stays in the adapters, so the shared
// component may not reach for a router port or name any of the adapter-owned
// route, org, query-param, tag, or desktop-bridge symbols.
const PLAN_FORBIDDEN_IMPORT_PREFIXES = ["@repo/navigation", "next/navigation"];
const PLAN_FORBIDDEN_NAMES = new Set([
  "buildSessionsSearchHref",
  "desktopApi",
  "hrefForNavId",
  "location",
  "NavId",
  "orgSlug",
  "tagId",
  "URLSearchParams",
  "useOrgSlug",
  "useSearchParamsValue",
]);
// The query-param NAME (`"q"`) and the routes it is appended to are adapter
// contracts; matching literal values (not file text) keeps a className or a
// comment from counting as a route.
const PLAN_FORBIDDEN_LITERAL = "q";
const PLAN_FORBIDDEN_LITERAL_SUBSTRINGS = ["/my-tasks", "/sessions"];

// Shared UI is surface-agnostic: no app-only alias, no app/desktop source, no
// Node/Electron runtime, no env, database, or observability coupling.
const SHARED_FORBIDDEN_IMPORT_PREFIXES = [
  "@/",
  "@repo/database",
  "@repo/observability",
  "electron",
  "node:",
];
const SHARED_FORBIDDEN_IMPORT_SUBSTRINGS = ["apps/app", "apps/desktop"];
const SHARED_FORBIDDEN_NAMES = new Set([
  "contextBridge",
  "desktopApi",
  "ipcMain",
  "ipcRenderer",
  "openFile",
  "openPath",
  "process",
  "shell",
]);
// `desktop:<channel>` IPC channel names only exist as string literals.
const DESKTOP_CHANNEL_LITERAL_RE = /desktop:[A-Za-z]/;

// Route construction and URL source reads stay callback-owned by the adapters.
const ROUTE_FORBIDDEN_NAMES = new Set([
  "location",
  "navigate",
  "pathname",
  "push",
  "replace",
  "route",
  "router",
  "searchParams",
  "URL",
  "URLSearchParams",
]);
const ROUTE_FORBIDDEN_NAME_PREFIX = "hrefFor";

describe("SidebarSearchForm source ownership", () => {
  it("keeps route, org, query-param, and desktop ownership out of shared UI", () => {
    const { importSpecifiers, names, literals } = sidebarSearchFormFacts();

    // Sanity: the parse resolved a real module, so an empty-AST regression
    // cannot make every assertion below vacuously pass.
    expect(names.length).toBeGreaterThan(0);
    expect(
      importSpecifiers.filter((specifier) =>
        hasAnyPrefix(specifier, PLAN_FORBIDDEN_IMPORT_PREFIXES)
      )
    ).toEqual([]);
    expect(names.filter((name) => PLAN_FORBIDDEN_NAMES.has(name))).toEqual([]);
    expect(literals.filter(isForbiddenRouteLiteral)).toEqual([]);
  });

  it("keeps shared search chrome free of app-only, desktop, Node, env, database, and observability coupling", () => {
    const { importSpecifiers, names, literals } = sidebarSearchFormFacts();

    expect(
      importSpecifiers.filter(
        (specifier) =>
          hasAnyPrefix(specifier, SHARED_FORBIDDEN_IMPORT_PREFIXES) ||
          SHARED_FORBIDDEN_IMPORT_SUBSTRINGS.some((substring) =>
            specifier.includes(substring)
          )
      )
    ).toEqual([]);
    expect(names.filter((name) => SHARED_FORBIDDEN_NAMES.has(name))).toEqual(
      []
    );
    expect(
      literals.filter((literal) => DESKTOP_CHANNEL_LITERAL_RE.test(literal))
    ).toEqual([]);
  });

  it("keeps route construction and URL source reads callback-owned by adapters", () => {
    const { names } = sidebarSearchFormFacts();

    expect(
      names.filter(
        (name) =>
          ROUTE_FORBIDDEN_NAMES.has(name) ||
          name.startsWith(ROUTE_FORBIDDEN_NAME_PREFIX)
      )
    ).toEqual([]);
  });
});

type SourceFacts = {
  importSpecifiers: string[];
  names: string[];
  literals: string[];
};

function sidebarSearchFormFacts(): SourceFacts {
  const sourceFile = parseSourceFileAt(SIDEBAR_SEARCH_FORM_PATH);
  return {
    importSpecifiers: importsOf(sourceFile).map(({ specifier }) => specifier),
    names: identifierNamesIn(sourceFile),
    literals: stringLiteralsIn(sourceFile),
  };
}

function hasAnyPrefix(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function isForbiddenRouteLiteral(literal: string): boolean {
  return (
    literal === PLAN_FORBIDDEN_LITERAL ||
    PLAN_FORBIDDEN_LITERAL_SUBSTRINGS.some((substring) =>
      literal.includes(substring)
    )
  );
}
