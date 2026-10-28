import { describe, expect, it, vi } from "vitest";

const implementationLeakProbe = vi.fn<() => string>();
const constructorImplementationProbe = vi.fn(() => "baseline");

describe("API Vitest mock isolation", { concurrent: false }, () => {
  it("allows a test to replace a mock implementation", () => {
    implementationLeakProbe.mockReturnValue("test-only implementation");
    constructorImplementationProbe.mockReturnValue("test-only replacement");

    expect(implementationLeakProbe()).toBe("test-only implementation");
    expect(implementationLeakProbe).toHaveBeenCalledOnce();
    expect(constructorImplementationProbe()).toBe("test-only replacement");
  });

  it("starts the next test without prior calls or implementation overrides", () => {
    expect(implementationLeakProbe).not.toHaveBeenCalled();
    expect(implementationLeakProbe()).toBeUndefined();
    expect(constructorImplementationProbe).not.toHaveBeenCalled();
    expect(constructorImplementationProbe()).toBe("baseline");
  });
});
