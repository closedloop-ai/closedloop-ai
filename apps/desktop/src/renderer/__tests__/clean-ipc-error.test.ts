import { describe, expect, it } from "vitest";
import { cleanIpcError } from "../clean-ipc-error";

describe("cleanIpcError", () => {
  it("strips the Electron IPC wrapper and doubled Error: prefix", () => {
    const err = new Error(
      "Error invoking remote method 'desktop:set-api-key': Error: API key must start with sk_live_"
    );

    expect(cleanIpcError(err, "Failed to set API key")).toBe(
      "API key must start with sk_live_"
    );
  });

  it("does not leak the internal IPC channel name", () => {
    const err = new Error(
      "Error invoking remote method 'desktop:apply-config': Error: profile not found"
    );

    const message = cleanIpcError(err, "Failed to apply profile");

    expect(message).not.toContain("desktop:apply-config");
    expect(message).not.toContain("invoking remote method");
    expect(message).toBe("profile not found");
  });

  it("collapses a single leading Error: prefix", () => {
    const err = new Error("Error: something broke");

    expect(cleanIpcError(err, "fallback")).toBe("something broke");
  });

  it("returns a plain Error's message unchanged when it has no wrapper", () => {
    const err = new Error("plain human message");

    expect(cleanIpcError(err, "fallback")).toBe("plain human message");
  });

  it("falls back for non-Error values", () => {
    expect(cleanIpcError("some string", "fallback message")).toBe(
      "fallback message"
    );
    expect(cleanIpcError(undefined, "fallback message")).toBe(
      "fallback message"
    );
    expect(cleanIpcError({ code: 500 }, "fallback message")).toBe(
      "fallback message"
    );
  });

  it("falls back when the cleaned message is empty", () => {
    const err = new Error("Error invoking remote method 'desktop:noop': ");

    expect(cleanIpcError(err, "fallback message")).toBe("fallback message");
  });
});
