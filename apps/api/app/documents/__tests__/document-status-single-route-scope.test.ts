/**
 * ISS-9559: the single status route demands the scope the capability advertises.
 *
 * Sibling of `document-status-bulk-route-scope.test.ts`, for the other half of
 * {@link DocumentStatusMutationOperation}. Without it the Single operation was
 * the drift the bulk pin was written to prevent: the capability test pinned the
 * table and nothing pinned `PUT /documents/[id]`, so moving that route's
 * `requiredScopes` left the advertisement saying "you may" while the route said
 * "you may not", with no test red.
 *
 * The route cannot import the table — an AST test reads its scopes and
 * understands only string literals — so this pins what the route actually
 * registers against a hand-written literal, keyed on the exported handler rather
 * than on registration order, because this module registers three.
 */
import { describe, expect, it, vi } from "vitest";

const registeredScopes = vi.hoisted(() => new Map<unknown, unknown>());

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (_handler: unknown, options?: { requiredScopes?: unknown }) => {
    const route = vi.fn();
    registeredScopes.set(route, options?.requiredScopes);
    return route;
  },
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveDocumentId: vi.fn(),
    resolveProjectId: vi.fn(),
  };
});

vi.mock("@/app/documents/document-service", () => ({
  documentService: { delete: vi.fn(), findById: vi.fn() },
}));

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: { getByVersion: vi.fn(), getLatest: vi.fn() },
}));

vi.mock("../../custom-fields/route-helpers", () => ({
  customFieldsPreflightResponse: vi.fn(),
  mergeCustomFieldsIntoResponse: vi.fn(),
}));

import { PUT } from "../[id]/route";

describe("PUT /documents/[id] authorization", () => {
  it("is registered demanding the write scope", () => {
    // Identity first: a `get` that missed would report `undefined`, which is
    // also what a route that stopped declaring scopes produces.
    expect(registeredScopes.has(PUT)).toBe(true);
    expect(registeredScopes.get(PUT)).toEqual(["write"]);
  });
});
