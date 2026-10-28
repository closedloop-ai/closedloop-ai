/**
 * DOC-36 R16, as it applies to `POST /documents/batch-move`.
 *
 * R15 makes this route the bulk change-project implementation, and R16 assigns
 * that action the `write` scope. The route used to declare nothing and inherit
 * `withAnyAuth`'s method-inferred default — the same value, reached by a rule
 * nobody wrote down, which is the distinction R16 exists to draw. This pins
 * what the route actually registers, so the declaration cannot be dropped back
 * to the inference without a red.
 */
import { describe, expect, it, vi } from "vitest";

const capturedRequiredScopes = vi.hoisted(() => [] as unknown[]);

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (_handler: unknown, options?: { requiredScopes?: unknown }) => {
    capturedRequiredScopes.push(options?.requiredScopes);
    return vi.fn();
  },
}));

vi.mock("@/app/documents/document-batch-move-service", () => ({
  documentBatchMoveService: { batchMove: vi.fn() },
}));
vi.mock("@/lib/batch-move-side-effects", () => ({
  emitBatchMoveSideEffects: vi.fn(),
}));

import "../batch-move/route";

describe("POST /documents/batch-move authorization", () => {
  it("is registered demanding the write scope", () => {
    // Length first: an absent options argument pushes `undefined`, and an
    // `undefined` entry is exactly what the inferred default looked like.
    expect(capturedRequiredScopes).toHaveLength(1);
    expect(capturedRequiredScopes).toEqual([["write"]]);
  });
});
