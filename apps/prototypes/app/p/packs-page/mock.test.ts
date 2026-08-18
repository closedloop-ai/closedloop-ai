import { describe, expect, it } from "vitest";
import {
  InstallSource,
  installSourceMeta,
  sourceMetaFor,
  unknownSourceMeta,
} from "./mock";

describe("sourceMetaFor", () => {
  it("returns the mapped meta for a known source", () => {
    expect(sourceMetaFor(InstallSource.Required)).toBe(
      installSourceMeta[InstallSource.Required]
    );
    expect(sourceMetaFor(InstallSource.Pushed)).toBe(
      installSourceMeta[InstallSource.Pushed]
    );
  });

  it("falls back to the unknown meta for an unmapped source value", () => {
    expect(sourceMetaFor("legacy_source")).toBe(unknownSourceMeta);
  });

  it("does not resolve inherited Object.prototype keys to a prototype member", () => {
    // Without an own-key guard, indexing with `constructor` would return the
    // Object constructor rather than falling through to the safe fallback.
    expect(sourceMetaFor("constructor")).toBe(unknownSourceMeta);
    expect(sourceMetaFor("__proto__")).toBe(unknownSourceMeta);
    expect(sourceMetaFor("toString")).toBe(unknownSourceMeta);
  });
});
