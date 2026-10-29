/**
 * ISS-8215 — the REAL second host for a persisted option colour.
 *
 * `EnumOptionBuilder`'s edit mode is what the org custom-fields settings tab
 * mounts, and it resolves a stored colour through its own `storedOptionColor`
 * before `ColorPicker` ever sees it. A test that renders `ColorPicker` with a
 * raw stored string proves that component's internal fallback and NOT this
 * translation, so the two branches of the gate are driven through the builder
 * here.
 */

import type { CustomFieldEnumOption } from "@repo/api/src/types/custom-field";
import { CUSTOM_FIELD_EDITOR_CONTRACTS_FLAG_KEY } from "@repo/api/src/types/custom-field-editor-contracts-flag";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnumOptionBuilder } from "../enum-option-builder";

const FIELD_ID = "field-1";
const COLOR_TRIGGER_PATTERN = /^Color: /;
const WHITESPACE_PATTERN = /\s+/;

let serverOptions: CustomFieldEnumOption[] = [];

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useCustomFieldEnumOptions: () => ({ data: serverOptions }),
  useCreateEnumOption: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateEnumOption: () => ({ mutate: vi.fn(), isPending: false }),
  useReorderEnumOptions: () => ({ mutate: vi.fn(), isPending: false }),
}));

afterEach(() => {
  cleanup();
  serverOptions = [];
});

describe("EnumOptionBuilder stored option colours", () => {
  it("reads a canonical id, and a legacy Tailwind class, as the colour its author picked", () => {
    serverOptions = [
      option("opt-1", "Ready", 0, "bg-success"),
      option("opt-2", "Blocked", 1, "purple"),
    ];

    renderBuilder(true);

    expect(swatchClasses()).toEqual(["bg-green-500", "bg-purple-500"]);
    expect(triggerLabels()).toEqual(["Color: green", "Color: purple"]);
  });

  it("without the gate a legacy class still reads as no colour at all", () => {
    serverOptions = [
      option("opt-1", "Ready", 0, "bg-success"),
      option("opt-2", "Blocked", 1, "purple"),
    ];

    renderBuilder(false);

    expect(swatchClasses()).toEqual(["bg-gray-300", "bg-purple-500"]);
    expect(triggerLabels()).toEqual(["Color: bg-success", "Color: purple"]);
  });

  it("keeps an uncoloured option uncoloured rather than naming it none", () => {
    serverOptions = [option("opt-1", "Ready", 0, "none")];

    renderBuilder(true);

    expect(swatchClasses()).toEqual(["bg-gray-300"]);
    expect(triggerLabels()).toEqual(["Color: none"]);
  });
});

function renderBuilder(flagEnabled: boolean) {
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: flagEnabled
          ? [CUSTOM_FIELD_EDITOR_CONTRACTS_FLAG_KEY]
          : [],
      })}
    >
      <EnumOptionBuilder fieldId={FIELD_ID} />
    </FeatureFlagAdapterProvider>
  );
}

function colorTriggers(): HTMLElement[] {
  return screen.getAllByRole("button", { name: COLOR_TRIGGER_PATTERN });
}

/** The swatch class each trigger paints, in DOM order. */
function swatchClasses(): string[] {
  return colorTriggers().map(
    (trigger) =>
      trigger
        .querySelector("span")
        ?.className.split(WHITESPACE_PATTERN)
        .find((token) => token.startsWith("bg-")) ?? ""
  );
}

function triggerLabels(): (string | null)[] {
  return colorTriggers().map((trigger) => trigger.getAttribute("aria-label"));
}

function option(
  id: string,
  name: string,
  sortOrder: number,
  color: string
): CustomFieldEnumOption {
  return {
    id,
    customFieldId: FIELD_ID,
    name,
    color,
    enabled: true,
    sortOrder,
  };
}
