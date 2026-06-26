import { describe, expect, it, vi } from "vitest";

const addNextjsError = vi.fn();

vi.mock("@datadog/browser-rum-nextjs", () => ({
  addNextjsError,
}));

describe("reportNextjsError", () => {
  it("passes only allowlisted custom context to Datadog", async () => {
    const { reportNextjsError } = await import(
      "@/lib/datadog-rum/report-error"
    );
    const error = new Error("fixed-message") as Error & { digest?: string };
    error.digest = "digest-123";

    reportNextjsError(error, {
      digest: "digest-123",
      routeTemplate: "/rum-validation",
      source: "rum-validation",
    });

    expect(addNextjsError).toHaveBeenCalledWith(
      expect.objectContaining({
        dd_context: {
          digest: "digest-123",
          routeTemplate: "/rum-validation",
          source: "rum-validation",
        },
      })
    );
    expect(
      JSON.stringify(addNextjsError.mock.calls[0]?.[0].dd_context)
    ).not.toContain("orgSlug");
    expect(error).not.toHaveProperty("dd_context");
  });
});
