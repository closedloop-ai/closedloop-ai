import { describe, expect, it } from "vitest";
import { schemaChecks } from "../scripts/check-json-schemas";
import { schemaManifest } from "../scripts/schema-manifest";

describe("schema coverage", () => {
  it("schemaChecks covers every path in the manifest", () => {
    const checkPaths: ReadonlySet<string> = new Set(
      schemaChecks.map((c) => c.path)
    );
    for (const entry of schemaManifest) {
      expect(
        checkPaths.has(entry.path),
        `schema-manifest lists ${entry.path} but schemaChecks has no entry for it`
      ).toBe(true);
    }
  });

  it("schemaChecks does not list a path absent from the manifest", () => {
    const manifestPaths: ReadonlySet<string> = new Set(
      schemaManifest.map((s) => s.path)
    );
    for (const check of schemaChecks) {
      expect(
        manifestPaths.has(check.path),
        `schemaChecks lists ${check.path} but schema-manifest does not`
      ).toBe(true);
    }
  });

  it("schemaChecks and manifest have the same id for each path", () => {
    const manifestById: ReadonlyMap<string, string> = new Map(
      schemaManifest.map((s) => [s.path, s.id])
    );
    for (const check of schemaChecks) {
      expect(check.id).toBe(manifestById.get(check.path));
    }
  });
});
