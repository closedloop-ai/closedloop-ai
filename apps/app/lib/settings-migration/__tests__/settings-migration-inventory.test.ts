/**
 * ISS-8380 AC1 — the migration inventory is checkable, not just asserted.
 *
 * The inventory is prose about other files. Prose about other files rots: the
 * version this replaced claimed `PATCH /organizations/{id}` (the route exports
 * `PUT`), a `GET` on `/settings/api-keys/org` and `/settings/api-keys/user`
 * (neither exports one), a `GET /api-keys/{id}` (only `DELETE`), and
 * `PUT /compute-targets/{id}/sharing` (it is `PATCH`). Every one of those would
 * have sent a v2 client to a 405, and nothing in the suite would have said so.
 *
 * So the oracle here is the TREE, never the inventory: each expectation is read
 * off the route module itself and compared to the row. A row cannot satisfy this
 * suite by describing itself.
 *
 * Read from the AST rather than text-scanned — `no-raw-text-source-scan` bans
 * scanning implementation source and names `ts.createSourceFile` as the
 * sanctioned alternative. It matters beyond compliance: these route modules
 * name HTTP verbs in prose docstrings constantly, which is exactly what a text
 * scan false-positives on.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SettingsPanelId as SettingsPanelIdValues } from "@repo/api/src/types/settings-panel";
import ts from "typescript6";
import { describe, expect, it } from "vitest";
import {
  SETTINGS_MIGRATION_HTTP_METHODS,
  SETTINGS_MIGRATION_INVENTORY,
  type SettingsMigrationEntry,
  SettingsMigrationHttpMethod,
  SettingsMigrationSubject,
} from "@/lib/settings-migration/settings-migration-inventory";

// `process.cwd()` is `apps/app` under this package's vitest run; the inventory
// cites repo-root-relative paths because it cites `apps/api` and `packages/*`.
const REPO_ROOT = path.resolve(process.cwd(), "..", "..");

const HTTP_METHOD_NAMES = new Set<string>(SETTINGS_MIGRATION_HTTP_METHODS);

const endpointRows = SETTINGS_MIGRATION_INVENTORY.filter(
  (entry) => entry.subject === SettingsMigrationSubject.Endpoint
);

/**
 * The HTTP methods a Next route module exports, in the two forms this repo's
 * routes actually use: `export const GET = withAuth(...)` and
 * `export async function POST(...)`.
 */
function exportedHttpMethods(
  absolutePath: string
): readonly SettingsMigrationHttpMethod[] {
  const source = ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const found = new Set<SettingsMigrationHttpMethod>();

  for (const statement of source.statements) {
    const isExported = ts
      .getModifiers(statement as ts.HasModifiers)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) {
      continue;
    }
    for (const name of declaredNames(statement)) {
      if (HTTP_METHOD_NAMES.has(name)) {
        found.add(name as SettingsMigrationHttpMethod);
      }
    }
  }
  return [...found].sort();
}

function declaredNames(statement: ts.Statement): readonly string[] {
  if (ts.isFunctionDeclaration(statement)) {
    return statement.name ? [statement.name.text] : [];
  }
  if (!ts.isVariableStatement(statement)) {
    return [];
  }
  return statement.declarationList.declarations.flatMap((declaration) =>
    ts.isIdentifier(declaration.name) ? [declaration.name.text] : []
  );
}

function sorted(
  methods: readonly SettingsMigrationHttpMethod[]
): readonly SettingsMigrationHttpMethod[] {
  return [...methods].sort();
}

function rowFor(legacy: string): SettingsMigrationEntry {
  const row = SETTINGS_MIGRATION_INVENTORY.find(
    (entry) => entry.legacy === legacy
  );
  if (!row) {
    throw new Error(`no inventory row named ${legacy}`);
  }
  return row;
}

describe("AC1 the inventory cites files that exist", () => {
  it.each(SETTINGS_MIGRATION_INVENTORY.map((entry) => [entry.legacy, entry]))(
    "%s",
    (_legacy, entry) => {
      expect(existsSync(path.join(REPO_ROOT, entry.legacyOwner))).toBe(true);
    }
  );

  it("cites at least one owner in each of the five subjects", () => {
    // A subject that silently emptied would otherwise leave every remaining
    // row green while the matrix stopped answering the acceptance criterion.
    for (const subject of Object.values(SettingsMigrationSubject)) {
      expect(
        SETTINGS_MIGRATION_INVENTORY.some((entry) => entry.subject === subject)
      ).toBe(true);
    }
  });
});

describe("AC1 every endpoint row names the methods its route really exports", () => {
  it("declares methods on endpoint rows and on nothing else", () => {
    for (const entry of SETTINGS_MIGRATION_INVENTORY) {
      const declaresMethods = entry.methods !== undefined;
      expect(declaresMethods).toBe(
        entry.subject === SettingsMigrationSubject.Endpoint
      );
    }
  });

  it.each(endpointRows.map((entry) => [entry.legacy, entry]))(
    "%s",
    (_legacy, entry) => {
      const absolutePath = path.join(REPO_ROOT, entry.legacyOwner);
      expect(sorted(entry.methods ?? [])).toEqual(
        exportedHttpMethods(absolutePath)
      );
    }
  );
});

describe("AC1 the four verbs the previous inventory got wrong", () => {
  // Pinned as literals rather than re-read from the row, so a row that reverted
  // to the wrong verb fails HERE with the ticket's own history attached, not
  // just as one anonymous case in the generated block above.
  it("workspace identity is PUT, never PATCH", () => {
    expect(rowFor("/organizations/{id}").methods).toEqual([
      SettingsMigrationHttpMethod.Get,
      SettingsMigrationHttpMethod.Put,
    ]);
  });

  it("target sharing is PATCH, never PUT", () => {
    expect(rowFor("/compute-targets/{id}/sharing").methods).toEqual([
      SettingsMigrationHttpMethod.Patch,
    ]);
  });

  it("the scoped Anthropic key routes are write-only", () => {
    const writeOnly = [
      SettingsMigrationHttpMethod.Put,
      SettingsMigrationHttpMethod.Delete,
    ];
    expect(rowFor("/settings/api-keys/org").methods).toEqual(writeOnly);
    expect(rowFor("/settings/api-keys/user").methods).toEqual(writeOnly);
  });

  it("a platform API key can be revoked but never re-read", () => {
    expect(rowFor("/api-keys/{id}").methods).toEqual([
      SettingsMigrationHttpMethod.Delete,
    ]);
  });
});

describe("AC1 the rows no v2 panel owns are recorded as unowned", () => {
  // Pinned as literals, one row per case, because the failure mode this guards
  // is not a missing row — it is a row that grew a plausible-looking owner. The
  // Profile panel reads Clerk account data and never calls the GitHub
  // integration route. A row that named it as the owner would make the removal
  // gate read as satisfied while the subject had nowhere to go.
  it.each(["/integrations/github", "User.githubUsername"])(
    "%s has no v2 owner",
    (legacy) => {
      expect(rowFor(legacy).v2Panel).toBeNull();
    }
  );

  it("still names an owner for the rows a v2 panel really does implement", () => {
    // The counterweight: an inventory that answered `null` everywhere would
    // pass the block above and say nothing.
    expect(rowFor("/api-keys").v2Panel).toBe(SettingsPanelIdValues.ApiKeys);
  });

  it.each([
    [
      "/{orgSlug}/settings?tab=integrations#anthropic-api-key",
      SettingsPanelIdValues.ApiKeys,
    ],
    ["/settings/api-keys", SettingsPanelIdValues.ApiKeys],
    ["/settings/api-keys/org", SettingsPanelIdValues.ApiKeys],
    ["/settings/api-keys/user", SettingsPanelIdValues.ApiKeys],
    [
      "Organization.claudeApiKeyEncrypted, claudeApiKeyLastFour, claudeApiKeySetAt",
      SettingsPanelIdValues.ApiKeys,
    ],
    ["/settings/pensero", SettingsPanelIdValues.ApiKeys],
    ["/integrations/google", SettingsPanelIdValues.Plugins],
  ])("%s is owned by the panel ISS-10316 mounted it on", (legacy, panel) => {
    expect(rowFor(legacy).v2Panel).toBe(panel);
  });
});

describe("the AST reader itself", () => {
  // Pinned in both directions: a reader that regressed to always-empty would
  // pass every row above whose route exports nothing, and one that regressed to
  // reporting every identifier would never disagree with a row again.
  it("reads both export forms and ignores prose and non-methods", () => {
    const fixture = path.join(
      REPO_ROOT,
      "apps/api/app/desktop/device-onboarding/start/route.ts"
    );
    expect(exportedHttpMethods(fixture)).toEqual([
      SettingsMigrationHttpMethod.Post,
    ]);
  });

  it("reports nothing for a module that exports no route handler", () => {
    const fixture = path.join(
      REPO_ROOT,
      "apps/app/lib/settings-migration/settings-migration-inventory.ts"
    );
    expect(exportedHttpMethods(fixture)).toEqual([]);
  });
});
