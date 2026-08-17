// Each specifier is written AT its own `import()` rather than collected into an
// array the loop then indirects through (ISS-5159, wongk review). The array form
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
  // module (wongk review, FEA-4293/4294).
  import("../dist/agent-session-filters.js"),
  // Same proof for the ISS-4905 fail-closed scope resolver: it imports
  // `../types/api-key.ts`, and `apps/mcp` loads it from dist over plain Node
  // ESM, so a specifier that failed to rewrite would break MCP auth at runtime
  // rather than at build time (wongk review, ISS-4905).
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
  // sees until the packaged app throws ERR_MODULE_NOT_FOUND (codex + wongk
  // review). Every new emitted helper a runtime consumer loads from dist gets a
  // line here.
  import("../dist/types/artifact-slug-parse.js"),
]);
