import { DocumentType } from "@repo/api/src/types/document";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { describe, expect, test } from "vitest";
import {
  getDocumentRoute,
  getDocumentTypeLabel,
  getDocumentTypeRoute,
  getLabelForSlug,
  getRouteForSlug,
  isNavigableDocument,
  withOrgSlug,
} from "../document-navigation";

describe("getDocumentRoute", () => {
  // FEA-4137: Feature was renamed "Issue" and its detail route moved to /issues/.
  test("routes Feature documents to the org-relative /issues/:slug", () => {
    const doc = createMockDocument({
      type: DocumentType.Feature,
      slug: "login-flow",
    });
    expect(getDocumentRoute(doc)).toBe("/issues/login-flow");
  });

  test("routes PRD documents to the org-relative /prds/:slug", () => {
    const doc = createMockDocument({
      type: DocumentType.Prd,
      slug: "checkout-prd",
    });
    expect(getDocumentRoute(doc)).toBe("/prds/checkout-prd");
  });

  test("routes ImplementationPlan documents to /implementation-plans/:slug", () => {
    const doc = createMockDocument({
      type: DocumentType.ImplementationPlan,
      slug: "auth-rewrite",
    });
    expect(getDocumentRoute(doc)).toBe("/implementation-plans/auth-rewrite");
  });

  test("returns null for Template documents", () => {
    const doc = createMockDocument({
      type: DocumentType.Template,
      slug: "blank-prd",
    });
    expect(getDocumentRoute(doc)).toBeNull();
  });

  // ISS-4382: the DOC (evergreen document) subtype now has a real editor at
  // /documents/:slug, so it IS internally navigable — getDocumentRoute routes
  // DOC rows there, making them clickable.
  test("routes Doc documents to the org-relative /documents/:slug", () => {
    const doc = createMockDocument({
      type: DocumentType.Doc,
      slug: "onboarding-guide",
    });
    expect(getDocumentRoute(doc)).toBe("/documents/onboarding-guide");
  });
});

describe("isNavigableDocument", () => {
  test("DOC is navigable now that it has an editor (ISS-4382)", () => {
    expect(isNavigableDocument({ type: DocumentType.Doc })).toBe(true);
  });

  test("Template stays non-navigable (no detail surface)", () => {
    expect(isNavigableDocument({ type: DocumentType.Template })).toBe(false);
  });
});

// FEA-3635: the linked-artifact wire shape (SessionLinkedArtifact) carries
// `documentType` + `slug`, so it resolves via getDocumentTypeRoute rather than
// the Artifact-keyed getArtifactRoute.
describe("getDocumentTypeRoute", () => {
  test("routes each navigable document type to its org-relative prefix", () => {
    expect(getDocumentTypeRoute(DocumentType.Feature, "FEA-3628")).toBe(
      "/issues/FEA-3628"
    );
    expect(getDocumentTypeRoute(DocumentType.Feature, "ISS-3628")).toBe(
      "/issues/ISS-3628"
    );
    expect(getDocumentTypeRoute(DocumentType.Prd, "PRD-538")).toBe(
      "/prds/PRD-538"
    );
    expect(
      getDocumentTypeRoute(DocumentType.ImplementationPlan, "PLN-810")
    ).toBe("/implementation-plans/PLN-810");
    expect(getDocumentTypeRoute(DocumentType.Doc, "DOC-1")).toBe(
      "/documents/DOC-1"
    );
  });

  test("returns null for a non-navigable type (Template)", () => {
    expect(getDocumentTypeRoute(DocumentType.Template, "blank")).toBeNull();
  });

  test("returns null when slug or documentType is missing", () => {
    expect(getDocumentTypeRoute(DocumentType.Feature, null)).toBeNull();
    expect(getDocumentTypeRoute(null, "FEA-3628")).toBeNull();
    expect(getDocumentTypeRoute(undefined, undefined)).toBeNull();
  });

  test("composes with withOrgSlug into an absolute path", () => {
    expect(
      withOrgSlug(
        "acme",
        getDocumentTypeRoute(DocumentType.Feature, "FEA-3628")
      )
    ).toBe("/acme/issues/FEA-3628");
  });
});

// FEA-4292: a branch's linked artifacts carry ONLY a slug (the slug embedded in
// the branch name — no documentType), so getRouteForSlug derives the type from
// the slug prefix and delegates to getDocumentTypeRoute.
describe("getRouteForSlug", () => {
  test("routes each navigable typed-slug prefix to its org-relative route", () => {
    expect(getRouteForSlug("FEA-3595")).toBe("/issues/FEA-3595");
    expect(getRouteForSlug("ISS-3595")).toBe("/issues/ISS-3595");
    expect(getRouteForSlug("PRD-538")).toBe("/prds/PRD-538");
    expect(getRouteForSlug("PLN-988")).toBe("/implementation-plans/PLN-988");
    expect(getRouteForSlug("DOC-1")).toBe("/documents/DOC-1");
  });

  // A lowercase branch-name slug must resolve to the CANONICAL-cased route, not a
  // lowercase one: the by-slug DB lookup is a case-sensitive exact match against
  // the stored `FEA-1952`/`ISS-1952` row, so `/issues/fea-1952` would 404 (wongk).
  test("normalizes a lowercase prefix to canonical case in the route", () => {
    expect(getRouteForSlug("fea-1952")).toBe("/issues/FEA-1952");
    expect(getRouteForSlug("prd-538")).toBe("/prds/PRD-538");
    expect(getRouteForSlug("pln-988")).toBe("/implementation-plans/PLN-988");
  });

  // The FEA compat alias resolves to the Issue route WITHOUT re-listing FEA here:
  // the alias entry is derived from SLUG_PREFIX_ALIASES (the single alias SSOT),
  // so both prefixes for the same identity route identically (wongk).
  test("resolves the FEA compat alias to the Issue route via the alias SSOT", () => {
    expect(getRouteForSlug("FEA-592")).toBe("/issues/FEA-592");
    expect(getRouteForSlug("ISS-592")).toBe("/issues/ISS-592");
  });

  test("returns null for a prefix with no navigable route (PRO/WRK/SES)", () => {
    expect(getRouteForSlug("PRO-1")).toBeNull();
    expect(getRouteForSlug("WRK-12")).toBeNull();
    expect(getRouteForSlug("SES-7")).toBeNull();
  });

  test("returns null for an untyped or empty slug", () => {
    expect(getRouteForSlug("not-a-typed-slug")).toBeNull();
    expect(getRouteForSlug("FEA-")).toBeNull();
    expect(getRouteForSlug("")).toBeNull();
    expect(getRouteForSlug(null)).toBeNull();
    expect(getRouteForSlug(undefined)).toBeNull();
  });

  test("composes with withOrgSlug into an absolute path", () => {
    expect(withOrgSlug("acme", getRouteForSlug("FEA-3595"))).toBe(
      "/acme/issues/FEA-3595"
    );
  });
});

describe("getDocumentTypeLabel", () => {
  test("names each document type", () => {
    expect(getDocumentTypeLabel(DocumentType.Feature)).toBe("Issue");
    expect(getDocumentTypeLabel(DocumentType.Prd)).toBe("PRD");
    expect(getDocumentTypeLabel(DocumentType.ImplementationPlan)).toBe("Plan");
    expect(getDocumentTypeLabel(DocumentType.Template)).toBe("Template");
    expect(getDocumentTypeLabel(DocumentType.Doc)).toBe("Document");
  });

  test("returns null for an unknown/absent type", () => {
    expect(getDocumentTypeLabel(null)).toBeNull();
    expect(getDocumentTypeLabel(undefined)).toBeNull();
  });
});

// FEA-4292: the branch panel names the artifact KIND per row from the slug
// alone. getLabelForSlug is the label peer of getRouteForSlug — same prefix →
// same DocumentType, so a routable slug always carries a kind label too.
describe("getLabelForSlug", () => {
  test("names each navigable typed-slug prefix", () => {
    expect(getLabelForSlug("FEA-3595")).toBe("Issue");
    expect(getLabelForSlug("ISS-3595")).toBe("Issue");
    expect(getLabelForSlug("PRD-538")).toBe("PRD");
    expect(getLabelForSlug("PLN-988")).toBe("Plan");
    expect(getLabelForSlug("DOC-1")).toBe("Document");
  });

  test("is case-insensitive on the prefix (branch-name slugs are lowercased)", () => {
    expect(getLabelForSlug("fea-1952")).toBe("Issue");
  });

  test("returns null for a prefix with no label (PRO/WRK/SES)", () => {
    expect(getLabelForSlug("PRO-1")).toBeNull();
    expect(getLabelForSlug("WRK-12")).toBeNull();
    expect(getLabelForSlug("SES-7")).toBeNull();
  });

  test("returns null for an untyped or empty slug", () => {
    expect(getLabelForSlug("not-a-typed-slug")).toBeNull();
    expect(getLabelForSlug("FEA-")).toBeNull();
    expect(getLabelForSlug("")).toBeNull();
    expect(getLabelForSlug(null)).toBeNull();
    expect(getLabelForSlug(undefined)).toBeNull();
  });

  test("agrees with getRouteForSlug: a routable slug always has a label", () => {
    for (const slug of ["FEA-3595", "PRD-538", "PLN-988", "DOC-1"]) {
      expect(getRouteForSlug(slug)).not.toBeNull();
      expect(getLabelForSlug(slug)).not.toBeNull();
    }
  });
});

describe("withOrgSlug", () => {
  test("prefixes an org-relative route with the org slug", () => {
    expect(withOrgSlug("test-org", "/prds/checkout-prd")).toBe(
      "/test-org/prds/checkout-prd"
    );
  });

  test("composes with getDocumentRoute to the full absolute path", () => {
    const doc = createMockDocument({
      type: DocumentType.Feature,
      slug: "login-flow",
    });
    expect(withOrgSlug("test-org", getDocumentRoute(doc))).toBe(
      "/test-org/issues/login-flow"
    );
  });

  test("stays null when the route is null (non-navigable artifact)", () => {
    expect(withOrgSlug("test-org", null)).toBeNull();
  });
});
