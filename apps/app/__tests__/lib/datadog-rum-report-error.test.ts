import { afterEach, describe, expect, it, vi } from "vitest";

const addNextjsError = vi.fn();

vi.mock("@datadog/browser-rum-nextjs", () => ({
  addNextjsError,
}));

afterEach(() => {
  vi.clearAllMocks();
});

async function loadReporter() {
  return await import("@/lib/datadog-rum/report-error");
}

describe("reportNextjsError", () => {
  it("passes only allowlisted custom context to Datadog", async () => {
    const { reportNextjsError } = await loadReporter();
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

  it("does not report Next.js notFound() control-flow digests (FEA-2404)", async () => {
    const { reportNextjsError } = await loadReporter();
    const error = Object.assign(new Error("not found"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });

    reportNextjsError(error, { source: "nextjs-error-boundary" });

    expect(addNextjsError).not.toHaveBeenCalled();
  });

  it("does not report Next.js redirect control-flow digests", async () => {
    const { reportNextjsError } = await loadReporter();
    const error = Object.assign(new Error("redirect"), {
      digest: "NEXT_REDIRECT;replace;/somewhere;307;",
    });

    reportNextjsError(error, { source: "nextjs-error-boundary" });

    expect(addNextjsError).not.toHaveBeenCalled();
  });

  it("reports genuine errors with digest and source context", async () => {
    const { reportNextjsError } = await loadReporter();
    const error = Object.assign(new Error("boom"), { digest: "abc123" });

    reportNextjsError(error, {
      source: "global-error",
      routeTemplate: "/[orgSlug]/prds/[slug]",
    });

    expect(addNextjsError).toHaveBeenCalledTimes(1);
    const reported = addNextjsError.mock.calls[0]?.[0] as Error & {
      digest?: string;
      dd_context?: { digest?: string; routeTemplate?: string; source: string };
    };
    expect(reported.message).toBe("boom");
    expect(reported.digest).toBe("abc123");
    expect(reported.dd_context).toMatchObject({
      digest: "abc123",
      routeTemplate: "/[orgSlug]/prds/[slug]",
      source: "global-error",
    });
  });
});
