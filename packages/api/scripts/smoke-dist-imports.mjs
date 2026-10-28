// Each specifier is written AT its own `import()` rather than collected into an
// array the loop then indirects through (ISS-5159, whitlockk review). The array form
// made every one of these a `.map()` callback parameter, which the Desktop
// gateway boundary guard cannot fold — so the guard reported one unresolvable
// specifier, and the allowlist waiver adjudicating it was keyed to the parameter
// NAME. Repointing the array at the privileged Desktop operations tree would
// have produced that same single allowed violation and left the gate green.
// Spelled out, every specifier folds to a literal the guard can prove stays
// outside that tree, and the waiver is gone.
await Promise.all([
  import("../dist/github-read-model.js"),
  import("../dist/github-checks-status.js"),
  // Emitted from a source file that imports `./types/billing-mode.ts`; proves
  // rewriteRelativeImportExtensions rewrote it to `.js` so a plain Node ESM
  // consumer (the Desktop main process loading from dist) can resolve the child
  // module (whitlockk review, FEA-4293/4294).
  import("../dist/agent-session-filters.js"),
  // Same proof for the ISS-4905 fail-closed scope resolver: it imports
  // `../types/api-key.ts`, and `apps/mcp` loads it from dist over plain Node
  // ESM, so a specifier that failed to rewrite would break MCP auth at runtime
  // rather than at build time (whitlockk review, ISS-4905).
  import("../dist/utils/api-key-scope-resolution.js"),
  // ISS-4883's canonical Branch completeness fold is consumed at runtime by
  // cloud and Desktop. Import its emitted entry to prove child specifiers were
  // rewritten for plain Node ESM consumers.
  import("../dist/types/branch-usage.js"),
  // ISS-5617: the typed-artifact-slug parser the desktop MAIN process runs when
  // it projects a local session's linked artifacts. It is two relative hops deep
  // (`./artifact-slug-prefixes.ts` → `./document.ts`), and the package build was
  // green while the emitted entry was unloadable — this list is the only thing
  // that executes dist, so an entry omitted here is a rewrite failure nobody
  // sees until the packaged app throws ERR_MODULE_NOT_FOUND (codex + whitlockk
  // review). Every new emitted helper a runtime consumer loads from dist gets a
  // line here.
  import("../dist/types/artifact-slug-parse.js"),
  // ISS-8372: the workspace-experience fold and its boundary read. Both are
  // emitted runtime helpers with relative child imports, and the boundary module
  // is the one a version-skewed Desktop build runs against a newer API payload —
  // exactly the consumer that would meet ERR_MODULE_NOT_FOUND rather than a
  // build error if a specifier failed to rewrite (davetho review).
  import("../dist/types/workspace-experience.js"),
  import("../dist/types/feature-assignment-boundary.js"),
  // ISS-8329: the invocation-sync wire schema. Capping its four int4 fields
  // pulled in `./session-artifact-link.ts` for the shared `PR_INT_MAX`, and that
  // module carried extensionless `./branch`, `./github-status` and
  // `./slug-prefix` specifiers, which `tsc` leaves alone — so the emitted schema
  // stopped loading under plain Node ESM while the package build stayed green
  // (codex review). Those three now carry `.ts`; this line is what fails the
  // build if a future edit reintroduces one anywhere in the chain.
  import("../dist/types/agent-component-invocation-schema.js"),
  // ISS-8377: the shell navigation view-model vocabulary. It imports
  // `./org-admin-role.ts` for the role set it folds, so this line is what fails
  // the build if that specifier ever loses its extension again (whitlockk review).
  import("../dist/types/navigation-view-model.js"),
  // ISS-8379: the Settings host capability projection. It emits runtime values
  // (`WEB_SETTINGS_HOST_CAPABILITIES`, the status/reason vocabularies) and value-
  // imports `./settings-panel.ts` for `SettingsPanelHost`, so an extensionless
  // specifier here would emit an unresolvable `./settings-panel` into
  // `dist/types/settings-host-capabilities.js` while the package build stayed
  // green (codex review). This line is what fails the build instead.
  import("../dist/types/settings-host-capabilities.js"),
  // ISS-8858: the status-counts response contract. It emits a runtime value
  // (`AGENT_SESSION_COUNTED_STATUSES`) and value-imports `./session-status.ts`
  // for the vocabulary it folds, so an extensionless specifier emits an
  // unresolvable `./session-status` into
  // `dist/types/agent-session-status-counts.js` while the package build stays
  // green (codex review, PR #6485). This line is what fails the build instead.
  import("../dist/types/agent-session-status-counts.js"),
  // ISS-9432: the normalized artifact-status tables and their display copy.
  // Both are emitted runtime value modules with relative child imports
  // (`./artifact-status.ts`, `./branch.ts`, `./project.ts`,
  // `./session-status.ts`), so a specifier that fails to rewrite would leave a
  // dist entry unloadable while the package build stayed green. These lines
  // are what fails the build instead.
  import("../dist/types/artifact-status-mapping.js"),
  import("../dist/types/artifact-status-display.js"),
  // ISS-9433: document status mutation error codes are a runtime contract used
  // by API, MCP, and app clients. Loading the emitted entry catches relative
  // import-extension regressions before generated/runtime consumers do.
  import("../dist/types/document-status-mutation.js"),
  // ISS-9437: the canonical root-rank table and the Branches status orderings
  // derived from it. Both emit runtime values and value-import relative children
  // (`./artifact-status.ts`, `./artifact-status-mapping.ts`), and the mapping
  // module in turn reaches `./branch-merged-state.ts` — whose own extensionless
  // `./github-status` specifier this build caught only because these entries
  // execute dist. These lines are what fails the build instead.
  import("../dist/types/artifact-status-rank.js"),
  import("../dist/types/branch-status-order.js"),
  // ISS-9300: the status edit/capability contract. It emits runtime values
  // (`ArtifactStatusVocabulary`, `ArtifactStatusEditSurface`,
  // `ArtifactStatusReadOnlyReason`, `ARTIFACT_STATUS_EDITABILITY`) that
  // `apps/api` will return and the desktop renderer will read (ISS-9433 /
  // ISS-9301); nothing consumes them yet, so this line is what fails the build
  // if a future edit gives it a relative child import that does not rewrite.
  import("../dist/types/artifact-status-contract.js"),
  // ISS-9306/ISS-9439: the priority contract and the search grammar that folds
  // it. Both emit runtime values (`isPriority`, `priorityOrdinal`,
  // `PRIORITY_ORDINAL`) and value-import relative children, so an extensionless
  // specifier emits an unresolvable `./common` into
  // `dist/types/priority-contract.js` while the package build stays green
  // (whitlockk review). These lines are what fails the build instead.
  import("../dist/types/priority-contract.js"),
  import("../dist/types/search-query.js"),
  // ISS-10197: `DesktopAgentSessionsSyncErrorCode` now initializes from
  // `./desktop-write-lane.ts`, which made this module's first relative VALUE
  // import. The desktop main process loads it from dist over plain Node ESM, so
  // a specifier that failed to rewrite would surface as ERR_MODULE_NOT_FOUND in
  // the packaged app rather than as a build error. This line is the build error.
  import("../dist/types/agent-session.js"),
]);
