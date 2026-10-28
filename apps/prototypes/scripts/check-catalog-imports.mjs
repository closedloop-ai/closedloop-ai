// CI gate (docs/design/prototype-sandbox.md): every @repo/design-system
// component import in apps/prototypes must map to a non-internal entry in the
// Storybook component catalog. Wired as this package's "test" script and run
// on every PR by the pr-test.yml `test-shard` job (--filter=prototypes). Deliberately
// NOT wired into the build: deploy builds stay test-free per FEA-1523.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { staleAllowlistEntries } from "./catalog-allowlist-staleness.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(appRoot, "..", "..");
const catalogPath = path.join(
  repoRoot,
  "packages/design-system/storybook/component-catalog.ts"
);

const catalog = await import(pathToFileURL(catalogPath).href);

const packagePrefixPattern = /^packages\/design-system\//;
const sourceFilePattern = /\.tsx?$/;

const allowedComponentSpecifiers = new Set(
  catalog.designSystemComponentCatalog
    .filter((entry) => !entry.internal)
    .map((entry) =>
      entry.sourcePath
        .replace(packagePrefixPattern, "@repo/design-system/")
        .replace(sourceFilePattern, "")
    )
);

// Non-component surfaces are infrastructure, not catalog entries: the root
// DesignSystemProvider, fonts/utils, theme provider, styles, hooks, shared
// storybook mock data, and the type/util modules colocated with components.
const infrastructurePattern =
  /^@repo\/design-system(\/(lib|providers|styles|hooks|storybook)\/.+)?$/;
const componentModuleAllowlist = new Set([
  "@repo/design-system/components/ui/chart-colors",
  "@repo/design-system/components/ui/table-toolbar-model",
  "@repo/design-system/components/ui/types",
  "@repo/design-system/components/ui/utils",
  // Pure metric-polarity contract (ISS-4633): the MetricPolarity/DeltaSentiment
  // enums and their sentiment/class maps. No React, no component runtime, so it
  // has no Storybook story and cannot be a catalog entry — it is a type/util
  // module colocated with components, same category as the entries above.
  "@repo/design-system/components/ui/primitives/metric-polarity",
]);

// Explicit stakeholder override for a componentized prototype: this adapter is
// mock-only and renders the real prop-driven Sessions V2 surface. Keep this
// exact-path allowlist narrow so prototypes cannot reach @repo/app hooks or
// product data adapters merely because the workspace dependency is installed.
const portableSurfaceAllowlist = new Set([
  // ISS-12523: mock persistence around the canonical prop-driven policy control.
  "@repo/app/shared/components/data-sync-policy-choice-demo",
  // ISS-12880: route-only composition of canonical Sessions list/detail
  // surfaces with the catalog prototype shell and fixture data.
  "@repo/app/agents/components/sessions/sessions-prototype-preview",
  "@repo/app/branches/components/branches-list-surface-v2-demo",
  // PRD-723's focused review host mounts this exact prop-driven composition.
  // The prototype supplies only the existing typed project fixture and route
  // callbacks; the shared surface owns the interaction contract and list.
  "@repo/app/shared/components/generic-artifact-surface/preview/components/grid-interaction-artifact-list-surface",
  // ISS-11819's session trace. The sandbox's own copy of the chart is gone: the
  // panel below composes the CANONICAL surface the production Trace tab renders,
  // and it lives in the sessions feature slice because that is where the trace
  // belongs.
  //
  // It takes its rows as an optional `invocations` prop defaulting to the shared
  // traced-session fixture, and keeps its view state in the URL rather than in
  // host React state — which is what lets it be a route of its own.
  "@repo/app/agents/components/detail/trace/preview/session-trace-preview-panel",
  "@repo/app/shared/components/generic-artifact-surface/preview/components/generic-artifact-detail-shell",
  "@repo/app/shared/components/generic-artifact-surface/preview/fixtures",
  "@repo/app/shared/components/generic-artifact-surface/preview/generic-artifact-preview",
  // ISS-10792's Details design-review harness: prop-free, fixtures only, no
  // data adapter. The host lives in the documents slice because it injects
  // the canonical priority editor (whose menu reads the unset flag
  // optionally) into the shared preview. Deleted with its route once the
  // layout is approved and built.
  "@repo/app/documents/components/details-design/details-design-preview-host",
  // ISS-11492's Web contact form. `contact-form` takes its transport as an
  // `onSubmit` prop and every un-ruled user-visible string as a REQUIRED `copy`
  // prop, so it reaches no hook, query or data adapter and cannot even mount
  // without a host supplying both — a sandbox supplying a simulated send and
  // `[copy TBD]` placeholders IS the intended consumer. `contact-form-schema`
  // is a dependency-free zod/const module (the field enum, the parse boundary),
  // the same bar the ISS-10006 `lib` entries clear.
  "@repo/app/marketing/contact/components/contact-form",
  "@repo/app/marketing/contact/components/contact-form-demo",
  "@repo/app/marketing/contact/lib/contact-form-schema",
  // ISS-10006's Web utility routes. Both surfaces take every prop as a required
  // value and reach no hook, query or data adapter — the whole probe and docs
  // transport is the host's — so a prototype supplying fixtures IS the intended
  // consumer. It mounts them rather than redrawing them because the question it
  // asks is which treatment a device-only capability gets, and a redrawn tab
  // strip cannot answer that: whether the tab is there at all is the answer.
  // The `lib` entries do carry runtime values — `DIAGNOSTICS_SECTIONS` is read
  // in a loop by the prototype's own test — but they are dependency-free type
  // and const modules, which is the bar this list enforces: no hook, no query,
  // no data adapter.
  "@repo/app/diagnostics/components/diagnostics-surface-v2",
  "@repo/app/diagnostics/lib/diagnostics-sections",
  "@repo/app/diagnostics/lib/diagnostics-source",
  "@repo/app/help/components/help-surface-v2",
  "@repo/app/help/lib/docs-help-payload",
  "@repo/app/help/lib/docs-help-source",
  // ISS-12522's data-sync level visual. The card is the canonical prop-driven
  // card every consent and settings surface draws (level, selected, a
  // host-rendered control, an optional visual) and the visual is a pure render
  // of the copy SSOT; neither reaches a hook, query or data adapter. The
  // desktop-data-sync-level sandbox mounts them so the visual is reviewed on
  // the real card rather than on a look-alike.
  "@repo/app/shared/components/data-sync-level-card",
  "@repo/app/shared/components/data-sync-level-visual",
  // The copy SSOT both of those render: plain per-level strings, no hook or
  // adapter. The sandbox reads radio names and badge labels from it so they
  // cannot drift from the card's visible title (PR #8823 review).
  "@repo/app/shared/lib/data-sync-copy",
  // ISS-12521's add-a-directory control on the directory scope list. The demo
  // is a mock host holding list state and a pick switcher; the fixtures module
  // holds fictional directories and glyph-only copy. Neither reaches a hook,
  // query, IPC bridge or data adapter.
  "@repo/app/shared/components/directory-scope-list-with-add-demo",
  "@repo/app/shared/components/directory-scope-list-with-add-fixtures",
  // ISS-12531's device data policy, read-only on web. The component is
  // prop-driven and composes shipped presentational parts; the fixtures module
  // holds fictional devices and placeholder copy. Neither reaches a hook,
  // query, IPC bridge or data adapter.
  "@repo/app/shared/components/device-data-policy",
  "@repo/app/shared/components/device-data-policy-fixtures",
  // ISS-12524's onboarding directory step. The demo is a mock host holding
  // list state inside the onboarding card; the fixtures module holds fictional
  // directories and placeholder copy. Neither reaches a hook, query, IPC
  // bridge or data adapter.
  "@repo/app/onboarding/components/guided-onboarding-directory-step-demo",
  "@repo/app/onboarding/components/guided-onboarding-directory-step-fixtures",
  // ISS-12519's four PRD-796 data-control flows. The demo is a mock host that
  // joins shipped PRD-796 components with fixture state and the shared
  // scenario panel; the fixtures module holds fictional directories and
  // sessions and placeholder copy. Neither reaches a hook, query, IPC bridge
  // or data adapter.
  "@repo/app/settings/components/data-controls-prototype-demo",
  "@repo/app/settings/components/data-controls-prototype-fixtures",
  // ISS-10337's shared prototype shell adapter: `SidebarProvider` + the real
  // `ShellSidebar` (fed the static mock nav fixture in
  // `prototype-shell-navigation.ts`) + `SidebarInset` + a breadcrumb header,
  // matching what 7 of the other 32 prototypes already hand-roll locally
  // (PLN-2026's top recommendation). No hook here reaches auth, org, or a
  // real router. It carries two mock-only dependencies: the
  // `createMemoryNavigation` adapter from `@repo/navigation`, explicitly
  // documented as "Not used in production surfaces.", and (ISS-10391) the real
  // `WorkspaceMenu` mounted behind a fixture host adapter — the port it reads
  // is injected, so no Clerk, org, or sign-out path is reachable from here,
  // and the entries with no mock state behind them are projected away rather
  // than rendered inert. The menu's Download entry reaches
  // `@repo/app/onboarding/hooks/use-detected-desktop-os` and
  // `onboarding/lib/desktop-platform-availability` transitively — a user-agent
  // read and a pure derivation over it, no auth, org, query or data adapter —
  // so this entry covers them, the way the composed-screen entries below cover
  // their sections.
  "@repo/app/shell/v2/components/prototype-shell",
  // ISS-10345's mock host for the real SearchSurfaceV2 (mode: Page): the
  // first migration of an EXISTING prototype to the production-bound
  // standard, not a new inception-mode build. This demo owns only React
  // state (a query string, a demo-state selector) and composes the real
  // SearchSurfaceV2 + the real SearchTypeControl + the real type:-token
  // helpers from search-type-tokens.ts against a static fixture list — no
  // hook, query, or data adapter anywhere in it. It exists (rather than the
  // prototype mounting SearchSurfaceV2 directly) because a production-bound
  // route's own .tsx files may render NO markup beyond allowlisted portable
  // surfaces: the query bar, the Type control, and the results surface
  // together need one composed, catalog-adjacent host, the same shape as
  // the SessionsListSurfaceV2Preview precedent.
  "@repo/app/search/components/search-surface-v2-page-demo",
  // ISS-10476: `projects-table` is the Projects table mounted bare by the
  // web-ui-kit gallery page; `project-summary-row` is the row TYPE its fixture
  // module declares against, so the sandbox cannot drift a second row shape.
  "@repo/app/projects/components/projects-table",
  "@repo/app/projects/lib/project-summary-row",
  // ISS-12938: the Web Master prototype's shared surfaces. Every route mounts
  // one of these exact modules and supplies only its router and image
  // adapters; the shell, routes and fixtures are mock-only and reach no
  // product hook, query or data adapter. `mock` carries the base path the
  // redirect routes read, and the three `projects` modules are the fixture
  // and href helpers pointer-hover-contract reuses.
  "@repo/app/shell/v2/components/web-master-preview/web-master-preview-shell",
  "@repo/app/shell/v2/components/web-master-preview/mock",
  "@repo/app/branches/components/prototype-preview/branches-web-master-route",
  "@repo/app/shell/v2/components/web-master-preview/routes/generic-artifact-route",
  "@repo/app/shell/v2/components/web-master-preview/routes/projects-route",
  "@repo/app/agents/components/sessions/web-master-legacy-preview/sessions-route",
  "@repo/app/shell/v2/components/web-master-preview/routes/web-master-page-routes",
  "@repo/app/shell/v2/components/web-master-preview/projects/project-artifact-list-fixture",
  "@repo/app/shell/v2/components/web-master-preview/projects/project-artifacts",
  "@repo/app/shell/v2/components/web-master-preview/projects/project-model",
  // ISS-12938: the Branches prototype's list, detail and fixtures, moved with
  // Web Master because its Branches route hosts them. The branches and
  // branch-trace-unavailable sandboxes read the same modules. Mock-only: no
  // product hook, query or data adapter.
  "@repo/app/branches/components/prototype-preview/components/branch-comments-panel",
  "@repo/app/branches/components/prototype-preview/components/branch-detail",
  "@repo/app/branches/components/prototype-preview/components/branch-files-changed-panel",
  "@repo/app/branches/components/prototype-preview/components/branch-list-fixtures",
  "@repo/app/branches/components/prototype-preview/components/branches-list",
  "@repo/app/branches/components/prototype-preview/components/detail-panels",
  "@repo/app/branches/components/prototype-preview/components/event-dot-position",
  "@repo/app/branches/components/prototype-preview/components/use-metric-presentation-state",
  "@repo/app/branches/components/prototype-preview/components/use-prototype-comments-control",
  "@repo/app/branches/components/prototype-preview/generic-adapter",
  "@repo/app/branches/components/prototype-preview/mock",
  "@repo/app/branches/components/prototype-preview/mock-detail",
  "@repo/app/branches/components/prototype-preview/timeline-fixtures",
  // ISS-12938: the Prototypes artifact detail Web Master hosts, its fixtures,
  // and the review-status vocabulary the sandbox registry aliases. Mock-only.
  "@repo/app/shell/v2/components/prototypes-preview/components/prototype-detail",
  "@repo/app/shell/v2/components/prototypes-preview/components/prototype-people",
  "@repo/app/shell/v2/components/prototypes-preview/mock",
  "@repo/app/shell/v2/components/prototypes-preview/prototype-status",
]);

const importPattern =
  /(?:from\s+|import\s+|import\()\s*["'](@repo\/(?:app|design-system)[^"']*)["']/g;

const violations = [];
const importedSpecifiers = new Set();
let importCount = 0;
let fileCount = 0;

for (const dir of ["app", "lib"]) {
  const entries = readdirSync(path.join(appRoot, dir), {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!(entry.isFile() && sourceFilePattern.test(entry.name))) {
      continue;
    }
    fileCount += 1;
    const filePath = path.join(entry.parentPath, entry.name);
    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(importPattern)) {
      importCount += 1;
      const specifier = match[1];
      importedSpecifiers.add(specifier);
      const reason = classify(specifier);
      if (reason) {
        violations.push(
          `${path.relative(repoRoot, filePath)}: "${specifier}" ${reason}`
        );
      }
    }
  }
}

for (const entry of staleAllowlistEntries(
  portableSurfaceAllowlist,
  importedSpecifiers
)) {
  violations.push(
    `scripts/check-catalog-imports.mjs: "${entry}" is in portableSurfaceAllowlist but no prototype imports it; remove the entry`
  );
}

if (violations.length > 0) {
  console.error("Catalog gate failed:\n");
  for (const violation of violations) {
    console.error(`  ${violation}`);
  }
  console.error(
    "\nPrototypes may only use design-system components listed (non-internal) in" +
      "\npackages/design-system/storybook/component-catalog.ts. If the component" +
      "\nreally exists in Storybook, refresh the catalog first:" +
      "\n  pnpm --filter storybook catalog:sync" +
      "\nPortable @repo/app previews require an explicit exact-path entry in" +
      "\nportableSurfaceAllowlist; product hooks and data adapters remain forbidden."
  );
  process.exit(1);
}

console.log(
  `catalog gate ok (${importCount} design-system imports across ${fileCount} files)`
);

function classify(specifier) {
  if (portableSurfaceAllowlist.has(specifier)) {
    return null;
  }
  if (specifier.startsWith("@repo/app")) {
    return "is not an explicitly approved mock-only portable surface";
  }
  if (infrastructurePattern.test(specifier)) {
    return null;
  }
  if (componentModuleAllowlist.has(specifier)) {
    return null;
  }
  if (specifier.startsWith("@repo/design-system/components/")) {
    if (allowedComponentSpecifiers.has(specifier)) {
      return null;
    }
    return "is not a non-internal component-catalog entry";
  }
  return "is not a known design-system surface (components/, lib/, providers/, styles/, hooks/, storybook/)";
}
