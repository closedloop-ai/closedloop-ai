import { DocumentType } from "@repo/api/src/types/document";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { describe, expect, test } from "vitest";
import { getDocumentRoute, withOrgSlug } from "../document-navigation";

describe("getDocumentRoute", () => {
  test("routes Feature documents to the org-relative /features/:slug", () => {
    const doc = createMockDocument({
      type: DocumentType.Feature,
      slug: "login-flow",
    });
    expect(getDocumentRoute(doc)).toBe("/features/login-flow");
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
      "/test-org/features/login-flow"
    );
  });

  test("stays null when the route is null (non-navigable artifact)", () => {
    expect(withOrgSlug("test-org", null)).toBeNull();
  });
});
