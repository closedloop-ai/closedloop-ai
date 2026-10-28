/**
 * Importing `reference-targets` must not read anything off `@repo/database`.
 *
 * `values-service` and `utils` both pull this module in, so it is transitively
 * imported by a large share of the custom-fields suites — and those suites mock
 * `@repo/database` with only the members they themselves use. A module-load
 * dereference of `ArtifactType` here therefore does not fail in this file; it
 * fails eight unrelated suites at IMPORT, with zero failing assertions to point
 * at the cause.
 *
 * The mock below is deliberately the minimum: `withDb` and nothing else.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ withDb: vi.fn() }));

describe("reference-targets import contract", () => {
  it("loads against a @repo/database mock that exports no enums", async () => {
    const module = await import("../reference-targets");

    // Reaching this line at all is the assertion — an eager enum dereference
    // rejects the import before any export exists to inspect.
    expect(typeof module.referenceSourceScope).toBe("function");
    expect(typeof module.isReferenceFieldType).toBe("function");
  });
});
