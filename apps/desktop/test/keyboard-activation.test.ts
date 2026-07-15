import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { activateOnEnterOrSpace } from "@closedloop-ai/design-system/lib/keyboard-activation";
import { keyboardEvent } from "./keyboard-activation-test-utils";

describe("activateOnEnterOrSpace", () => {
  test("activates and prevents default on the Space key", () => {
    const element = {};
    let activations = 0;
    const handler = activateOnEnterOrSpace(() => {
      activations += 1;
    });

    const event = keyboardEvent(" ", element, element);
    handler(event);

    assert.equal(activations, 1, "Space must trigger activation");
    assert.equal(
      event.defaultPrevented,
      true,
      "Space must preventDefault to suppress page scroll"
    );
  });

  test("activates and prevents default on the Enter key", () => {
    const element = {};
    let activations = 0;
    const handler = activateOnEnterOrSpace(() => {
      activations += 1;
    });

    const event = keyboardEvent("Enter", element, element);
    handler(event);

    assert.equal(activations, 1, "Enter must trigger activation");
    assert.equal(event.defaultPrevented, true);
  });

  test("ignores keydowns bubbling up from a nested target", () => {
    const element = {};
    const nestedTarget = {};
    let activations = 0;
    const handler = activateOnEnterOrSpace(() => {
      activations += 1;
    });

    const event = keyboardEvent(" ", element, nestedTarget);
    handler(event);

    assert.equal(
      activations,
      0,
      "currentTarget !== target must be a no-op so nested controls keep their behavior"
    );
    assert.equal(event.defaultPrevented, false);
  });

  test("does not activate for other keys", () => {
    const element = {};
    let activations = 0;
    const handler = activateOnEnterOrSpace(() => {
      activations += 1;
    });

    // "Spacebar" is the legacy alias a regression might match instead of " ".
    for (const key of ["Spacebar", "Tab", "a", "ArrowDown"]) {
      const event = keyboardEvent(key, element, element);
      handler(event);
      assert.equal(activations, 0, `${key} must not trigger activation`);
      assert.equal(event.defaultPrevented, false);
    }
  });
});
