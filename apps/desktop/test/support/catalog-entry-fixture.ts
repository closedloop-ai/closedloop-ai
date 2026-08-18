/**
 * @file catalog-entry-fixture.ts
 * @description Shared `CatalogEntry` builder for pack install tests. Extracted
 * so the harness-detection and auto-harness-resolution suites do not each carry
 * their own copy of the ~25-field row shape.
 */

import type { CatalogEntry } from "../../src/shared/agent-db-contract.js";

/**
 * A minimal, valid catalog entry. Defaults describe a plain (NOT
 * `single_install`) claude-only pack — the shape ISS-5027 could not install.
 */
export function makeCatalogEntry(
  overrides: Partial<CatalogEntry> = {}
): CatalogEntry {
  return {
    category: null,
    contents: null,
    contentsCache: null,
    description: null,
    descriptionLive: null,
    detectionPatterns: null,
    displayName: "Code Review",
    forks: null,
    githubUrl: "https://github.com/example/code-review",
    harnessAgnostic: false,
    harnesses: ["claude"],
    history: [],
    installCommands: { claude: "claude plugin install code-review" },
    installNotes: null,
    installedHarnesses: [],
    lastRelease: null,
    marketplaceUrl: null,
    packId: "code-review",
    pinOrder: null,
    placeholderReason: null,
    postInstall: null,
    projectScoped: false,
    readmeExcerpt: null,
    seedVersion: 1,
    singleInstall: false,
    skillCount: 0,
    stars: null,
    uninstallCommands: {},
    usageCount: 0,
    verified: true,
    ...overrides,
  };
}
