import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { badgeVariants } from "../components/ui/badge";
import { buttonVariants } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { INVALID_STATE_UTILITIES } from "../components/ui/invalid-state";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { Select, SelectTrigger } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { toggleVariants } from "../components/ui/toggle";

const WHITESPACE_PATTERN = /\s+/;

describe("shared aria-invalid treatment", () => {
  it("is composed by every primitive that carries the invalid state", () => {
    const primitives = invalidStatePrimitives();
    // Guards a table that lost its rows and would assert nothing.
    expect(primitives).toHaveLength(8);
    const utilities = INVALID_STATE_UTILITIES.split(" ");
    expect(utilities.length).toBeGreaterThan(1);
    for (const [name, className] of primitives) {
      expect(className.split(WHITESPACE_PATTERN), name).toEqual(
        expect.arrayContaining(utilities)
      );
    }
  });
});

/**
 * ISS-9063 review. `invalid-state.ts` exists so the `aria-invalid` treatment —
 * including the compound `aria-invalid:focus-visible:` ring that outranks the
 * unfocused halo — has ONE owner instead of the eight verbatim copies it had.
 *
 * The contrast sweep in `packages/app/test/a11y` measures that string's ring
 * against WCAG 1.4.11's 3:1. It can only measure the SHIPPED indicator if the
 * primitives actually compose the string, which is what this asserts: each
 * class string below comes off the production path — a `cva` map called, or the
 * component rendered and read out of the DOM — so a primitive that stops
 * composing it fails here rather than quietly keeping the old halo.
 */
function invalidStatePrimitives(): readonly (readonly [string, string])[] {
  return [
    ["Button", buttonVariants()],
    ["Badge", badgeVariants()],
    ["Toggle", toggleVariants()],
    ["Input", renderedClassName(<Input aria-invalid />, "input")],
    ["Textarea", renderedClassName(<Textarea aria-invalid />, "textarea")],
    ["Checkbox", renderedClassName(<Checkbox aria-invalid />, "checkbox")],
    [
      "RadioGroupItem",
      renderedClassName(
        <RadioGroup>
          <RadioGroupItem value="one" />
        </RadioGroup>,
        "radio-group-item"
      ),
    ],
    [
      "SelectTrigger",
      renderedClassName(
        <Select>
          <SelectTrigger />
        </Select>,
        "select-trigger"
      ),
    ],
  ];
}

function renderedClassName(element: ReactElement, slot: string): string {
  const { container, unmount } = render(element);
  const rendered = container.querySelector(`[data-slot="${slot}"]`);
  if (rendered === null) {
    throw new Error(`No [data-slot="${slot}"] element rendered`);
  }
  const { className } = rendered as HTMLElement;
  unmount();
  return className;
}
