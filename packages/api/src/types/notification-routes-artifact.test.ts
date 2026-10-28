import { describe, expect, it } from "vitest";
import { DOCUMENT_ROUTE_PREFIX, DocumentType } from "./document";
import {
  ARTIFACT_ROUTE_PREFIXES,
  getNotificationEntityPath,
  isArtifactRoutePrefix,
  NotificationEntityKind,
} from "./notification-routes";

describe("getNotificationEntityPath — artifact", () => {
  it("routes a PRD under /documents", () => {
    expect(
      getNotificationEntityPath({
        kind: NotificationEntityKind.Artifact,
        subtype: DocumentType.Prd,
        slug: "PRD-9",
      })
    ).toBe(`/${DOCUMENT_ROUTE_PREFIX}/PRD-9`);
  });

  it("routes a Feature under /documents", () => {
    expect(
      getNotificationEntityPath({
        kind: NotificationEntityKind.Artifact,
        subtype: DocumentType.Feature,
        slug: "ISS-1",
      })
    ).toBe(`/${DOCUMENT_ROUTE_PREFIX}/ISS-1`);
  });

  it("routes templates through /documents", () => {
    expect(
      getNotificationEntityPath({
        kind: NotificationEntityKind.Artifact,
        subtype: DocumentType.Template,
        slug: "TPL-3",
      })
    ).toBe("/documents/TPL-3");
  });

  it("throws on an unknown kind that bypassed the type", () => {
    const params = JSON.parse('{"kind":"mystery"}');
    expect(() => getNotificationEntityPath(params)).toThrow(
      'Unhandled notification entity kind: {"kind":"mystery"}'
    );
  });
});

describe("ARTIFACT_ROUTE_PREFIXES", () => {
  it("holds the canonical prefix and the legacy prefixes", () => {
    expect([...ARTIFACT_ROUTE_PREFIXES].sort()).toEqual([
      "documents",
      "features",
      "implementation-plans",
      "issues",
      "prds",
    ]);
  });
});

describe("isArtifactRoutePrefix", () => {
  it.each(["prds", "issues", "features", "documents", "implementation-plans"])(
    "accepts %s",
    (prefix) => {
      expect(isArtifactRoutePrefix(prefix)).toBe(true);
    }
  );

  it.each(["sessions", "branches", "", "PRDS"])("rejects %j", (prefix) => {
    expect(isArtifactRoutePrefix(prefix)).toBe(false);
  });
});
