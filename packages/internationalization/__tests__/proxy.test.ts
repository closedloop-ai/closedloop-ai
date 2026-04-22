import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted() runs before all imports and vi.mock factories, making the
// returned value safe to reference inside mock factories.
// ---------------------------------------------------------------------------

type ResolveLocale = (request: NextRequest) => string;

const captured = vi.hoisted(() => ({
  resolveLocale: undefined as ResolveLocale | undefined,
}));

vi.mock("next-international/middleware", () => ({
  createI18nMiddleware: (options: {
    resolveLocaleFromRequest?: ResolveLocale;
  }) => {
    captured.resolveLocale = options.resolveLocaleFromRequest;
    // Return a no-op middleware stand-in; its value is not asserted by these tests.
    return () => new Response();
  },
}));

vi.mock("@formatjs/intl-localematcher", () => ({
  match: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import after mocks are registered so the module-load-time side-effects see
// the mocked versions of createI18nMiddleware and matchLocale.
import { match as matchLocale } from "@formatjs/intl-localematcher";
import { log } from "@repo/observability/log";
import "../proxy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(acceptLanguage: string): NextRequest {
  return new NextRequest("http://localhost/", {
    headers: { "accept-language": acceptLanguage },
  });
}

function resolveLocale(request: NextRequest): string {
  if (!captured.resolveLocale) {
    throw new Error("resolveLocaleFromRequest was not captured — mock failed");
  }
  return captured.resolveLocale(request);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveLocaleFromRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the locale resolved by matchLocale for a normal Accept-Language header", () => {
    vi.mocked(matchLocale).mockReturnValueOnce("es");

    const result = resolveLocale(makeRequest("es,en;q=0.9"));

    expect(result).toBe("es");
    expect(matchLocale).toHaveBeenCalledOnce();
  });

  it("returns the default locale when matchLocale throws a RangeError", () => {
    vi.mocked(matchLocale).mockImplementationOnce(() => {
      throw new RangeError("Incorrect locale information provided");
    });

    const result = resolveLocale(makeRequest("invalid-garbage-*"));

    expect(result).toBe("en");
  });

  it("calls log.warn with the correct message when falling back due to a RangeError", () => {
    const errorMessage = "Incorrect locale information provided";
    vi.mocked(matchLocale).mockImplementationOnce(() => {
      throw new RangeError(errorMessage);
    });

    resolveLocale(makeRequest("invalid-garbage-*"));

    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      "i18n locale resolution failed, falling back to default",
      { error: errorMessage }
    );
  });

  it("re-throws non-RangeError exceptions without logging", () => {
    const unexpected = new TypeError("unexpected internal failure");
    vi.mocked(matchLocale).mockImplementationOnce(() => {
      throw unexpected;
    });

    expect(() => resolveLocale(makeRequest("en"))).toThrow(unexpected);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
