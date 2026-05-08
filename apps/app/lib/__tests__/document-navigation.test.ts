import { DocumentType } from "@repo/api/src/types/document";
import { describe, expect, test } from "vitest";
import { createMockDocument } from "@/__tests__/fixtures/documents";
import { getDocumentRoute } from "../document-navigation";

describe("getDocumentRoute", () => {
  test("routes Feature documents to /features/:slug", () => {
    const doc = createMockDocument({
      type: DocumentType.Feature,
      slug: "login-flow",
    });
    expect(getDocumentRoute(doc)).toBe("/features/login-flow");
  });

  test("routes PRD documents to /prds/:slug", () => {
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
