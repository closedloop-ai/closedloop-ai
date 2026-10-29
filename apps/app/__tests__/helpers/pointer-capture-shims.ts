import { afterEach, beforeEach } from "vitest";

// Radix dropdown/select primitives drive open state through pointer-capture
// APIs jsdom does not implement, so a real click-to-open interaction throws
// without these. They are installed per-test and removed afterwards: leaving
// them on `Element.prototype` would let a later suite depend on an API jsdom
// lacks and still pass (AGENTS.md — restore mutated browser globals).
const POINTER_CAPTURE_SHIMS = {
  hasPointerCapture: () => false,
  setPointerCapture: () => undefined,
  releasePointerCapture: () => undefined,
  scrollIntoView: () => undefined,
} as const;

type ShimmedMethod = keyof typeof POINTER_CAPTURE_SHIMS;

export function installPointerCaptureShims() {
  const originalDescriptors = new Map<
    ShimmedMethod,
    PropertyDescriptor | undefined
  >();

  beforeEach(() => {
    for (const [method, shim] of Object.entries(POINTER_CAPTURE_SHIMS)) {
      const name = method as ShimmedMethod;
      originalDescriptors.set(
        name,
        Object.getOwnPropertyDescriptor(Element.prototype, name)
      );
      if (Element.prototype[name]) {
        continue;
      }
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        writable: true,
        value: shim,
      });
    }
  });

  afterEach(() => {
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) {
        Object.defineProperty(Element.prototype, name, descriptor);
        continue;
      }
      Reflect.deleteProperty(Element.prototype, name);
    }
    originalDescriptors.clear();
  });
}
