import {
  capitalize,
  cn,
  handleError,
} from "@closedloop-ai/design-system/lib/utils";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

/**
 * ISS-10309. `lib/utils.ts` is a different module from `components/ui/utils.ts`
 * (which `ui-utils.test.ts` owns). Its only branches are in `parseError`, the
 * private helper behind `handleError`: every value a caller catches is turned
 * into the one string a toast shows, so each branch decides what the user reads.
 */

afterEach(() => {
  vi.mocked(toast.error).mockClear();
});

describe("handleError", () => {
  it("toasts an Error's message, not its stringified form", () => {
    handleError(new TypeError("boom"));

    // String(new TypeError("boom")) is "TypeError: boom". This pins that the
    // name prefix never reaches the toast; it does not pin WHICH branch reads
    // the message, since the generic `message` branch would read it too.
    expect(toast.error).toHaveBeenCalledExactlyOnceWith("boom");
  });

  it("toasts the message field of a non-Error object that carries one", () => {
    handleError({ message: "from the wire", code: 500 });

    expect(toast.error).toHaveBeenCalledExactlyOnceWith("from the wire");
  });

  it("stringifies a non-string message field", () => {
    handleError({ message: 404 });

    expect(toast.error).toHaveBeenCalledExactlyOnceWith("404");
  });

  it("stringifies an object without a message field", () => {
    // Pins current behavior; looks odd because the user reads
    // "[object Object]" rather than anything about the failure.
    handleError({ code: 500 });

    expect(toast.error).toHaveBeenCalledExactlyOnceWith("[object Object]");
  });

  it("toasts a thrown string verbatim", () => {
    handleError("plain failure");

    expect(toast.error).toHaveBeenCalledExactlyOnceWith("plain failure");
  });

  it.each([
    ["null", null, "null"],
    ["undefined", undefined, "undefined"],
    ["zero", 0, "0"],
  ])(
    "stringifies a falsy %s instead of reading a message off it",
    (_label, value, expected) => {
      // The `error &&` guard is what keeps `'message' in null` from throwing.
      expect(() => handleError(value)).not.toThrow();
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(expected);
    }
  );
});

describe("capitalize", () => {
  it("upper-cases only the first character", () => {
    expect(capitalize("hello world")).toBe("Hello world");
  });

  it("returns an empty string unchanged", () => {
    expect(capitalize("")).toBe("");
  });
});

describe("cn", () => {
  it("lets a later conflicting Tailwind class win and drops falsy inputs", () => {
    expect(cn("px-2 py-1", false, null, undefined, "px-4")).toBe("py-1 px-4");
  });

  it("flattens conditional object and array inputs", () => {
    expect(cn(["a", { b: true, c: false }], "d")).toBe("a b d");
  });
});
