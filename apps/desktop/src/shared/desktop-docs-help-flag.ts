/**
 * FEA-3843 / PRD-555 (M1): desktop-only Labs flag (camelCase, persisted
 * DesktopSettings field) gating the in-app Docs & Help experience — the Help
 * nav/view, the command-palette docs provider, and the contextual "Help on
 * this" affordances. Off by default so it dogfoods before graduating.
 *
 * Declared in this LEAF module — no imports, no registry — rather than inline in
 * `feature-flags.ts`. ISS-5145: the E2E flag-seeding contract spec needs this
 * key, and `feature-flags.ts` reaches it through extensionless
 * `@repo/api/src/types/…` specifiers that Playwright's ESM loader cannot
 * resolve — importing the registry from a spec aborts the whole file at load. A
 * leaf keeps the constant reachable from the harness without duplicating the
 * string into a test.
 *
 * IMPORT IT FROM HERE, not from `feature-flags.ts`: `noBarrelFile` forbids that
 * module re-exporting it, so it only imports it (for its registry entry). Every
 * consumer — `use-nav-gates.ts`, the command-palette / help-view /
 * help-on-this-button suites, and the E2E spec — points at this leaf directly.
 */
export const DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY = "docsHelp";
