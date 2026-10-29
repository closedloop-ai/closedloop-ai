import { SpanTelemetrySchema } from "@closedloop-ai/telemetry-contract/span";
import { describe, expect, it } from "vitest";
import { resolveSpanErrorType } from "../telemetry/span-error-cause";

/**
 * ISS-7217. Two contracts, and the tests below have to hold BOTH:
 *
 *   1. A 5xx span carries a USABLE cause — a caught error yields a class name,
 *      and a machine code widens it into something RCA can act on.
 *   2. NO USER CONTENT reaches the span — the message, the path, the address,
 *      the credential that rode in on the error all resolve to nothing.
 *
 * A test for (2) alone would pass against a function that returns `undefined`
 * unconditionally, so every leak case here is paired with a positive control
 * proving the resolver is not inert.
 */

class PrismaClientKnownRequestError extends Error {
  code = "P2002";
  constructor() {
    super("Unique constraint failed on the fields: (`email`)");
    this.name = "PrismaClientKnownRequestError";
  }
}

describe("resolveSpanErrorType", () => {
  it("names the exception class of a caught error", () => {
    expect(resolveSpanErrorType(new TypeError("boom"))).toBe("TypeError");
  });

  it("widens the class with a stable machine code when the error carries one", () => {
    expect(resolveSpanErrorType(new PrismaClientKnownRequestError())).toBe(
      "PrismaClientKnownRequestError.P2002"
    );
  });

  it.each([
    ["ECONNREFUSED", "connect ECONNREFUSED 10.0.0.4:5432"],
    ["UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"],
  ])("keeps the %s transport code", (code, message) => {
    const error = Object.assign(new Error(message), { code });

    expect(resolveSpanErrorType(error)).toBe(`Error.${code}`);
  });

  it("falls back to the constructor name when the error has no own name", () => {
    class DocumentGenerationFailure extends Error {}
    const error = new DocumentGenerationFailure("x");
    Reflect.deleteProperty(error, "name");
    Object.defineProperty(error, "name", { value: "" });

    expect(resolveSpanErrorType(error)).toBe("DocumentGenerationFailure");
  });

  it("names the subclass of a custom error that never assigns its own name", () => {
    // The inherited `Error.prototype.name` is `"Error"`, so a resolver that
    // reads `name` before the constructor reports every one of these as a bare
    // `Error` and loses the failure class the attribute promises.
    class DocumentGenerationFailure extends Error {}

    expect(resolveSpanErrorType(new DocumentGenerationFailure("boom"))).toBe(
      "DocumentGenerationFailure"
    );
  });

  it("keeps an explicitly assigned name over the constructor name", () => {
    // `this.name`/`e.name` is a deliberate declaration by whoever threw, so it
    // stays authoritative — preferring the constructor unconditionally would
    // throw away the more specific answer.
    class WrappedFailure extends Error {}
    const error = new WrappedFailure("boom");
    error.name = "UpstreamTimeout";

    expect(resolveSpanErrorType(error)).toBe("UpstreamTimeout");
  });

  it("falls back to the inherited name when the constructor is anonymous", () => {
    // An anonymous class expression has an empty `constructor.name`, so the
    // "prefer the constructor" rule must not turn a nameable `Error` into
    // nothing.
    const error = new (class extends Error {})("boom");

    expect(resolveSpanErrorType(error)).toBe("Error");
  });

  /**
   * Totality. This reducer runs inside `errorResponse` and every auth wrapper's
   * `catch`, so a value whose accessors throw must not make the attribution
   * path throw — that would replace the intended JSON 500 with a rejected
   * handler. A field that cannot be read is a field the span does not carry.
   */
  describe("hostile accessors", () => {
    it.each(["name", "constructor", "code"] as const)(
      "survives an error with a throwing %s getter",
      (field) => {
        const error = new Error("boom");
        Object.defineProperty(error, field, {
          configurable: true,
          get() {
            throw new Error(`hostile ${field} getter`);
          },
        });

        // Still resolves the class it CAN read, rather than degrading to
        // nothing the moment one field is hostile.
        expect(() => resolveSpanErrorType(error)).not.toThrow();
        expect(resolveSpanErrorType(error)).toBe("Error");
      }
    );

    it("survives a Proxy whose every trap throws", () => {
      const hostile = new Proxy(new Error("boom"), {
        get() {
          throw new Error("hostile get trap");
        },
        getOwnPropertyDescriptor() {
          throw new Error("hostile getOwnPropertyDescriptor trap");
        },
        has() {
          throw new Error("hostile has trap");
        },
      });

      expect(() => resolveSpanErrorType(hostile)).not.toThrow();
      expect(resolveSpanErrorType(hostile)).toBeUndefined();
    });
  });

  /**
   * The load-bearing case. Every string here is a shape real user content takes
   * when it rides an error into the failing layer. None may survive, and none
   * may survive PARTIALLY REDACTED either — a `[redacted]`-bearing remnant still
   * carries whatever the pattern did not recognize.
   */
  it.each([
    ["prose from a message", "Invalid document id supplied"],
    ["a filesystem path", "/Users/someone/notes/plan.md"],
    ["a query string", "GET /documents?token=abc&q=secret"],
    ["an email address", "owner@example.com"],
    ["a live API key", "sk_live_A1b2C3d4E5f6G7h8"],
    ["a prompt fragment", "Summarize the attached contract for Acme Corp"],
  ])("refuses to name an error whose class is %s", (_name, hostile) => {
    const error = new Error("boom");
    error.name = hostile;

    expect(resolveSpanErrorType(error)).toBeUndefined();
  });

  it("drops a secret-shaped code rather than emitting it redacted", () => {
    const error = Object.assign(new Error("boom"), {
      code: "sk_live_A1b2C3d4E5f6G7h8",
    });

    // Not `Error.sk_live_…`, and not `Error.[redacted]` either: the sanitizer
    // is a detector here, so a touched candidate is dropped whole. The class
    // name alone is deliberately NOT salvaged — the value that matched is the
    // one the code claimed to be, and half an answer would read as a real one.
    expect(resolveSpanErrorType(error)).toBeUndefined();
  });

  it.each([
    ["a string", "database exploded"],
    ["null", null],
    ["a number", 500],
    ["a bare object", {}],
  ])("returns nothing for %s, which names no class", (_name, thrown) => {
    expect(resolveSpanErrorType(thrown)).toBeUndefined();
  });

  it("ignores a code that is not code-shaped", () => {
    const error = Object.assign(new Error("boom"), {
      code: "failed while reading /etc/passwd",
    });

    expect(resolveSpanErrorType(error)).toBe("Error");
  });

  it("keeps a code at the 32-character ceiling", () => {
    const error = Object.assign(new Error("boom"), {
      code: "A".repeat(32),
    });

    expect(resolveSpanErrorType(error)).toBe(`Error.${"A".repeat(32)}`);
  });

  it("drops a code past the 32-character ceiling", () => {
    const error = Object.assign(new Error("boom"), {
      code: "A".repeat(33),
    });

    expect(resolveSpanErrorType(error)).toBe("Error");
  });

  /**
   * Whatever this resolver emits must still satisfy the published contract —
   * otherwise the `.strict()` span parse would reject the payload and drop
   * every attribute on the line, not just this one.
   */
  it("only ever emits values the span schema accepts", () => {
    for (const thrown of [
      new TypeError("boom"),
      new PrismaClientKnownRequestError(),
      Object.assign(new Error("x"), { code: "ETIMEDOUT" }),
    ]) {
      const errorType = resolveSpanErrorType(thrown);

      expect(errorType).toBeDefined();
      expect(
        SpanTelemetrySchema.shape["error.type"].safeParse(errorType).success
      ).toBe(true);
    }
  });
});
