// @vitest-environment jsdom
import type { Page } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_STABILITY_ATTRIBUTE,
  createControlIdentityObservation,
  observeControlIdentity,
} from "./e2e/helpers/control-identity-observation.js";

const LABEL = "Load more events";

const disposals: (() => void)[] = [];

let disconnect: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  globalThis.document.body.innerHTML = `<main><button>${LABEL}</button></main>`;
  disconnect = vi.spyOn(globalThis.MutationObserver.prototype, "disconnect");
});

afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose();
  }
  globalThis.document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function control(): HTMLButtonElement {
  const node = globalThis.document.querySelector("button");
  if (!node) {
    throw new Error("Expected the fixture control");
  }
  return node;
}

function observe() {
  const observation = createControlIdentityObservation({
    name: LABEL,
    attribute: CONTROL_STABILITY_ATTRIBUTE,
    value: "yes",
  });
  disposals.push(observation.dispose);
  return observation;
}

describe("control identity during an existing quiet window", () => {
  it("reuses only the exact unchanged original control and disposes its handle", () => {
    const node = control();
    const observation = observe();
    expect(node.hasAttribute(CONTROL_STABILITY_ATTRIBUTE)).toBe(false);
    expect(observation.finish()).toBe(true);
    expect(node.getAttribute(CONTROL_STABILITY_ATTRIBUTE)).toBe("yes");
    observation.dispose();
    expect(disconnect).toHaveBeenCalled();
  });

  it.each([
    "same-node reinsertion",
    "replacement",
    "text revert",
    "attribute revert",
  ])(
    "refuses a marker after %s even before observer microtasks run",
    (mutation) => {
      const node = control();
      const observation = observe();
      if (mutation === "same-node reinsertion") {
        const parent = node.parentNode;
        node.remove();
        parent?.appendChild(node);
      } else if (mutation === "replacement") {
        const replacement = globalThis.document.createElement("button");
        replacement.textContent = LABEL;
        node.replaceWith(replacement);
      } else if (mutation === "text revert") {
        node.textContent = "Loading more events";
        node.textContent = LABEL;
      } else {
        node.disabled = true;
        node.disabled = false;
      }
      expect(observation.finish()).toBe(false);
      expect(control().hasAttribute(CONTROL_STABILITY_ATTRIBUTE)).toBe(false);
      observation.dispose();
    }
  );

  it("refuses reuse when a matching control only arrives after observation began", () => {
    const node = control();
    node.remove();
    const observation = observe();
    globalThis.document.body.appendChild(node);
    expect(observation.finish()).toBe(false);
    expect(node.hasAttribute(CONTROL_STABILITY_ATTRIBUTE)).toBe(false);
    observation.dispose();
  });

  it("disconnects on a failed existing wait without granting a marker", async () => {
    const observation = observe();
    const waitFailure = new Error("Original quiet observer failed");
    const originalWait = async () => {
      try {
        await Promise.reject(waitFailure);
      } finally {
        observation.dispose();
      }
    };
    await expect(originalWait()).rejects.toBe(waitFailure);
    expect(control().hasAttribute(CONTROL_STABILITY_ATTRIBUTE)).toBe(false);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

it("routes the real Page adapter through the serializable observer factory", async () => {
  const stop = new Error("Synthetic Page boundary stop");
  const evaluateHandle = vi
    .fn<Page["evaluateHandle"]>()
    .mockRejectedValue(stop);
  await expect(observeControlIdentity({ evaluateHandle }, LABEL)).rejects.toBe(
    stop
  );
  expect(evaluateHandle).toHaveBeenCalledWith(
    createControlIdentityObservation,
    {
      name: LABEL,
      attribute: CONTROL_STABILITY_ATTRIBUTE,
      value: "yes",
    }
  );
});
