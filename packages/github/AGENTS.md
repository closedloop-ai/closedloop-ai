# GitHub Package Rules

## Subpath Modules

Import via direct path — these are not re-exported from `index.ts`:

- **`artifact-reference-parser`** — Extract `PLN-N` / `FEA-N` slugs and URLs from PR title/body. Entry point: `parseArtifactReferences(title, body, appBaseUrl?)`.
- **`prompt-snapshot-parser`** — Parse agents-snapshot markdown frontmatter into `PromptsSnapshot`. Entry point: `parsePromptsSnapshotFromMarkdownEntries(entries)`.
- **`electron-release`** — `getLatestElectronRelease()` selects the latest complete Desktop release from the Desktop-specific `symphony-alpha` release metadata contract.
- **`keys`** — `keys()` (server) and `clientKeys()` (app-safe) env validators.

## Parser Conventions

- **New parsers belong here**, not in `apps/api/lib/`. Import via subpath: `@repo/github/artifact-reference-parser`.
- **Every new parser module must include unit tests** in `__tests__/`.
- **Do not add barrel re-exports** to `index.ts` for parser modules — direct subpath imports avoid Biome's `noBarrelFile` rule.
- **Top-level regex** — declare `const MY_REGEX = /pattern/` at module scope, not inside functions.
- **Never use `str.match(regex)`** — use `RegExp.exec(str)` or `str.matchAll(regex)`.
- Parser input types are module-specific: file-content parsers may accept `Buffer` or markdown entries, while PR title/body parsers accept strings. Follow the exported function signature and return typed objects from `@repo/api/src/types/`.
- Return `null` or empty structures on parse failure; log warnings with `[module-name]` prefix via `@repo/observability/log`.

## Domain Rules

- When mapping pull-request review comments, preserve GitHub's original anchor fields as fallbacks for canonical line data. Outdated comments can have `line: null` while `original_line` remains populated, and downstream branch-view projection/backfill code still needs a stable anchor.
- When resolving Desktop releases from GitHub, do not rely on repo-global latest release semantics or on the first page of repository releases containing a Desktop release. Query the Desktop channel/tag directly or page until the Desktop-specific release contract is found.
