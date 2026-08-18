import type { SessionLinkedArtifact } from "@repo/api/src/types/agent-session";
import { DocumentType } from "@repo/api/src/types/document";
import { describe, expect, it } from "vitest";
import { buildArtifactWebHref } from "../artifact-web-href";

// The origin the caller resolves from the active gateway profile
// (`useWebAppOrigin`), deliberately NOT the production default: a stage-pointed
// desktop must build a stage URL for its stage org.
const WEB_APP_ORIGIN = "https://app.closedloop-stage.ai";

/**
 * ISS-4898: the desktop renderer's only possible destination for a linked
 * artifact is the ABSOLUTE web-app URL — an in-app `/issues/<slug>` href would
 * be dropped by its nav guard. These pin what it builds, and just as
 * importantly what it refuses to build.
 */
function artifact(
  slug: string,
  documentType: DocumentType | null
): SessionLinkedArtifact {
  return {
    documentType,
    id: `id-${slug}`,
    name: `Name of ${slug}`,
    role: "referenced",
    slug,
  };
}

describe("buildArtifactWebHref (ISS-4898)", () => {
  it.each([
    ["ISS-4544", DocumentType.Feature, "/acme/issues/ISS-4544"],
    ["FEA-4375", DocumentType.Feature, "/acme/issues/FEA-4375"],
    ["PRD-538", DocumentType.Prd, "/acme/prds/PRD-538"],
    [
      "PLN-988",
      DocumentType.ImplementationPlan,
      "/acme/implementation-plans/PLN-988",
    ],
    ["DOC-1", DocumentType.Doc, "/acme/documents/DOC-1"],
  ])("builds the org-scoped web URL for %s", (slug, documentType, path) => {
    expect(
      buildArtifactWebHref(WEB_APP_ORIGIN, "acme", artifact(slug, documentType))
    ).toBe(`${WEB_APP_ORIGIN}${path}`);
  });

  it("produces an absolute https URL, which is what makes the pill open externally", () => {
    const href = buildArtifactWebHref(
      WEB_APP_ORIGIN,
      "acme",
      artifact("ISS-4544", DocumentType.Feature)
    );

    // The shared row only renders the external `<a target="_blank">` branch for
    // an absolute http(s) href; a root-relative one would render an in-app Link
    // the desktop nav guard silently drops.
    expect(href?.startsWith("https://")).toBe(true);
    expect(new URL(href as string).pathname).toBe("/acme/issues/ISS-4544");
  });

  it("returns null for a non-navigable artifact rather than a URL that 404s", () => {
    expect(
      buildArtifactWebHref(WEB_APP_ORIGIN, "acme", artifact("SES-7", null))
    ).toBeNull();
  });

  it("returns null when the artifact carries no slug", () => {
    expect(
      buildArtifactWebHref(WEB_APP_ORIGIN, "acme", {
        documentType: DocumentType.Feature,
        id: "no-slug",
        name: "Unslugged",
        role: "referenced",
        slug: null,
      })
    ).toBeNull();
  });

  it("honors the configured origin rather than a hardcoded production host", () => {
    // The slug comes from whichever cloud the active gateway profile names, so
    // pairing it with a production origin would link a stage user at a
    // same-named production org — someone else's data.
    expect(
      buildArtifactWebHref(
        "http://localhost:3000",
        "acme",
        artifact("ISS-4544", DocumentType.Feature)
      )
    ).toBe("http://localhost:3000/acme/issues/ISS-4544");
  });
});
