/**
 * ISS-8215 — the Sessions add-field dialog must persist a canonical colour id,
 * not the design-system dialog's Tailwind class.
 *
 * The bug the reviewer reported is not visible inside the Sessions dialog: the
 * class renders correctly THERE and only reads as grey somewhere else. So each
 * case here takes the value the dialog actually handed the controller and feeds
 * it to a SECOND, non-Sessions host — the canonical `ColorPicker` every other
 * custom-field surface renders — and asserts what that host shows.
 */

import type {
  CreateCustomFieldInput,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import { CUSTOM_FIELD_EDITOR_CONTRACTS_FLAG_KEY } from "@repo/api/src/types/custom-field-editor-contracts-flag";
import type { ColorName } from "@repo/app/custom-fields/components/color-picker";
import { ColorPicker } from "@repo/app/custom-fields/components/color-picker";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionsAddFieldDialog } from "../sessions-list-custom-fields";

const FIELD_TITLE_PATTERN = /Field title/;
const COLOR_TRIGGER_PATTERN = /^Color: /;

afterEach(cleanup);

describe("SessionsAddFieldDialog option colours", () => {
  it("persists the canonical colour id, and a second host renders that colour", async () => {
    const created = await createSingleSelectField({ flagEnabled: true });

    expect(created.enumOptions).toEqual([
      { color: "green", name: "Ready", sortOrder: 0 },
    ]);

    cleanup();
    renderInSecondHost(created.enumOptions?.[0]?.color);

    expect(swatchClassName()).toContain("bg-green-500");
    expect(swatchClassName()).not.toContain("bg-gray-300");
    expect(
      screen.getByRole("button", { name: "Color: green" })
    ).toBeInTheDocument();
  });

  it("without the gate persists the dialog's Tailwind class, which the second host cannot read", async () => {
    const created = await createSingleSelectField({ flagEnabled: false });

    expect(created.enumOptions).toEqual([
      { color: "bg-success", name: "Ready", sortOrder: 0 },
    ]);

    cleanup();
    renderInSecondHost(created.enumOptions?.[0]?.color);

    expect(swatchClassName()).toContain("bg-gray-300");
    expect(swatchClassName()).not.toContain("bg-green-500");
  });
});

/**
 * Drives the shipped dialog through the shipped `SessionsAddFieldDialog` and
 * returns what the controller was actually handed. Asserting on this rather
 * than on a hand-built draft is what keeps the test on the production wiring.
 */
async function createSingleSelectField({
  flagEnabled,
}: {
  flagEnabled: boolean;
}): Promise<CreateCustomFieldInput> {
  let captured: CreateCustomFieldInput | undefined;
  const onCreateField = vi.fn((input: CreateCustomFieldInput) => {
    captured = input;
    return {} as CustomFieldWithOptions;
  });
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: flagEnabled
          ? [CUSTOM_FIELD_EDITOR_CONTRACTS_FLAG_KEY]
          : [],
      })}
    >
      <SessionsAddFieldDialog
        controller={{
          fields: [],
          onCreateField,
          valuesBySessionId: new Map(),
        }}
        onOpenChange={vi.fn()}
        open
      />
    </FeatureFlagAdapterProvider>
  );

  fireEvent.change(screen.getByRole("textbox", { name: FIELD_TITLE_PATTERN }), {
    target: { value: "Stage" },
  });
  const optionInputs = screen.getAllByPlaceholderText("Type an option name");
  fireEvent.change(optionInputs[0] as HTMLElement, {
    target: { value: "Ready" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create field" }));

  await waitFor(() => expect(onCreateField).toHaveBeenCalledTimes(1));
  if (!captured) {
    throw new Error("the dialog never reached onCreateField");
  }
  return captured;
}

/**
 * The canonical custom-field colour control, mounted with no Sessions code in
 * the tree. The cast models exactly what this test is about: a row persisted
 * with a value the prop type says cannot occur, because the write path put one
 * there.
 */
function renderInSecondHost(persistedColor: string | undefined) {
  render(
    <ColorPicker
      onChange={vi.fn()}
      value={(persistedColor ?? null) as ColorName | null}
    />
  );
}

function swatchClassName(): string {
  const trigger = screen.getByRole("button", { name: COLOR_TRIGGER_PATTERN });
  return trigger.querySelector("span")?.className ?? "";
}
