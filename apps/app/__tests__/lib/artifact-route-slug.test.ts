import { describe, expect, it } from "vitest";
import { resolveRedirect } from "@/lib/app-route-redirects";
import { resolveClientFetchedArtifactSlug } from "@/lib/artifact-route-slug";

const ACTIVE_ORG = "acme";

describe("resolveClientFetchedArtifactSlug", () => {
  it.each([
    ["/acme/documents/ISS-12", "ISS-12"],
    ["/acme/documents/PRD-3", "PRD-3"],
    ["/acme/documents/PLN-7", "PLN-7"],
    // A legacy SLUG on the live prefix is a live path and still resolves.
    ["/acme/documents/FEA-9", "FEA-9"],
    // ISS-12855: the Doc page reads its document from the browser like every
    // other type, so it is prewarmed too.
    ["/acme/documents/DOC-4", "DOC-4"],
  ])("names the slug of the detail page at %s", (path, slug) => {
    expect(resolveClientFetchedArtifactSlug(path, ACTIVE_ORG)).toBe(slug);
  });

  it.each([
    ["/acme/issues"],
    ["/acme/documents/ISS-12/branches"],
    ["/documents/ISS-12"],
    ["/acme/sessions/abc"],
    // Legacy per-type prefixes never reach a render (see below).
    ["/acme/issues/ISS-12"],
    ["/acme/prds/PRD-3"],
    ["/acme/features/FEA-9"],
    // Slugs are per-org sequences resolved in the ACTIVE org, so before the
    // switch this would read another org's document of the same slug.
    ["/other-org/documents/ISS-12"],
  ])("names nothing for %s", (path) => {
    expect(resolveClientFetchedArtifactSlug(path, ACTIVE_ORG)).toBeNull();
  });

  it("names nothing while the session has no active org", () => {
    expect(
      resolveClientFetchedArtifactSlug("/acme/documents/ISS-12", null)
    ).toBeNull();
  });

  it("names nothing on a legacy prefix, which never reaches a render", () => {
    const legacyPath = "/acme/features/FEA-9";

    // The redirect is what makes the omission correct rather than a gap: the
    // proxy sends this path to its `/documents/` equivalent before the shell
    // mounts, so prewarming it would warm a page nobody lands on.
    expect(resolveRedirect(legacyPath, "acme")?.pathname).toBe(
      "/acme/documents/FEA-9"
    );
    expect(resolveClientFetchedArtifactSlug(legacyPath, ACTIVE_ORG)).toBeNull();
  });
});
