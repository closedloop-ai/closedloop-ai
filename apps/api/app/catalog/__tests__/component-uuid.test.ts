/**
 * FEA-3909 / PRD-527 F4 — pack-member identity precedence (PD5).
 *
 * The reader contract: prefer the provenance-free `definitionVersionId` when
 * present, else fall back to the legacy provenance-tainted `componentUuid`
 * compatibility identity (preserved by this FEAT), else `null`.
 */

import { describe, expect, it } from "vitest";
import {
  PackMemberIdentityKind,
  resolvePackMemberIdentity,
} from "../component-uuid";

describe("resolvePackMemberIdentity (F4 reader precedence)", () => {
  it("prefers the provenance-free definitionVersionId when present", () => {
    const resolved = resolvePackMemberIdentity({
      definitionVersionId: "dv-123",
      componentUuid: "uuid-legacy",
    });
    expect(resolved).toEqual({
      id: "dv-123",
      kind: PackMemberIdentityKind.DefinitionVersion,
    });
  });

  it("falls back to the legacy componentUuid when the F1 link is absent", () => {
    const resolved = resolvePackMemberIdentity({
      definitionVersionId: null,
      componentUuid: "uuid-legacy",
    });
    expect(resolved).toEqual({
      id: "uuid-legacy",
      kind: PackMemberIdentityKind.ComponentUuid,
    });
  });

  it("treats undefined definitionVersionId the same as null (compatibility with old clients that omit the field)", () => {
    const resolved = resolvePackMemberIdentity({
      definitionVersionId: undefined,
      componentUuid: "uuid-legacy",
    });
    expect(resolved).toEqual({
      id: "uuid-legacy",
      kind: PackMemberIdentityKind.ComponentUuid,
    });
  });

  it("returns null when the member carries neither identity (asset-only / unlinked-and-unhashed)", () => {
    expect(
      resolvePackMemberIdentity({
        definitionVersionId: null,
        componentUuid: null,
      })
    ).toBeNull();
  });
});
