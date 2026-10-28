import { describe, expect, it } from "vitest";
import { parseError, UNREADABLE_ERROR_MESSAGE } from "../error";

describe("parseError", () => {
  it.each([
    ["Error instances", new Error("boom"), "boom"],
    ["string message objects", { message: "failed" }, "failed"],
    ["numeric message objects", { message: 42 }, "42"],
    ["objects without messages", { code: "E_FAIL" }, "[object Object]"],
    ["null", null, "null"],
    ["string primitives", "plain failure", "plain failure"],
    ["numeric primitives", 17, "17"],
  ])("normalizes %s", (_label, input, expected) => {
    expect(parseError(input)).toBe(expected);
  });

  it("reports a value whose message cannot be read instead of throwing", () => {
    // Callers are catch blocks that owe their caller a response — the desktop
    // auth wrapper logs through this before it records the error cause. A
    // thrown value with a throwing `message` getter must not escape the catch
    // that was handling it and reject the handler.
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

    expect(() => parseError(hostile)).not.toThrow();
    expect(parseError(hostile)).toBe(UNREADABLE_ERROR_MESSAGE);
  });
});
