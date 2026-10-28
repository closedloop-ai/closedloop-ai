/**
 * ISS-8215 — the option dot in `CustomFieldValueEditor`.
 *
 * `ColorDot` fed the persisted string straight to `style.backgroundColor`, so a
 * canonical id painted the CSS named colour while the picker painted the
 * palette class, and a legacy `bg-success` painted nothing at all. The colour
 * column is an unconstrained string server-side, so the last case here pins the
 * capability the fix must NOT take away: a row holding a raw CSS colour still
 * renders that colour.
 */

import type {
  CustomFieldEnumOption,
  CustomFieldSettingWithOptions,
  CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { CUSTOM_FIELD_EDITOR_CONTRACTS_FLAG_KEY } from "@repo/api/src/types/custom-field-editor-contracts-flag";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomFieldValueEditor } from "../custom-field-value-editor";

const OPTION_NAME = "High";

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useUpdateCustomFieldValue: () => ({ mutate: vi.fn(), isPending: false }),
}));

afterEach(cleanup);

describe("CustomFieldValueEditor option dot", () => {
  it("paints a legacy Tailwind class as the palette colour, with no inline style", () => {
    renderEditor({ color: "bg-success", flagEnabled: true });

    expect(dot().className).toContain("bg-green-500");
    expect(dot().getAttribute("style")).toBeNull();
  });

  it("paints a canonical id as the same class the colour picker uses", () => {
    renderEditor({ color: "green", flagEnabled: true });

    expect(dot().className).toContain("bg-green-500");
    expect(dot().getAttribute("style")).toBeNull();
  });

  it("without the gate a legacy class reaches CSS, which drops it and draws nothing", () => {
    renderEditor({ color: "bg-success", flagEnabled: false });

    expect(dot().className).not.toContain("bg-green-500");
    // `bg-success` is not a CSS colour, so the declaration is refused outright
    // and the attribute never lands — the dot is invisible, not merely grey.
    expect(dot().getAttribute("style")).toBeNull();
  });

  it("still renders a raw CSS colour the palette does not own", () => {
    renderEditor({ color: "#ff0000", flagEnabled: true });

    expect(dot().getAttribute("style")).toBe(
      "background-color: rgb(255, 0, 0);"
    );
  });
});

/** The dot is the only span the trigger draws beside the option's name. */
function dot(): HTMLElement {
  const label = screen.getByText(OPTION_NAME);
  const found = label.parentElement?.querySelector("span.rounded-full");
  if (!(found instanceof HTMLElement)) {
    throw new Error("the option dot never rendered");
  }
  return found;
}

function renderEditor({
  color,
  flagEnabled,
}: {
  color: string;
  flagEnabled: boolean;
}) {
  const option: CustomFieldEnumOption = {
    id: "opt-1",
    customFieldId: "field-1",
    name: OPTION_NAME,
    color,
    enabled: true,
    sortOrder: 0,
  };
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: flagEnabled
          ? [CUSTOM_FIELD_EDITOR_CONTRACTS_FLAG_KEY]
          : [],
      })}
    >
      <CustomFieldValueEditor
        entityId="proj-1"
        entityType={CustomFieldEntityType.Project}
        setting={setting(option)}
        value={valueWith(option)}
      />
    </FeatureFlagAdapterProvider>
  );
}

function setting(option: CustomFieldEnumOption): CustomFieldSettingWithOptions {
  return {
    id: "setting-1",
    customFieldId: "field-1",
    entityType: CustomFieldEntityType.Project,
    entityId: "proj-1",
    isImportant: false,
    isRequired: false,
    sortOrder: 0,
    createdAt: new Date("2026-08-25T12:00:00.000Z"),
    customField: {
      id: "field-1",
      organizationId: "org-1",
      name: "Priority",
      description: null,
      fieldType: CustomFieldType.Enum,
      createdById: null,
      createdAt: new Date("2026-08-25T12:00:00.000Z"),
      updatedAt: new Date("2026-08-25T12:00:00.000Z"),
      precision: null,
      numberFormat: null,
      currencyCode: null,
      customLabel: null,
      customLabelPosition: null,
      isGlobalToOrg: false,
      entityTypes: [CustomFieldEntityType.Project],
      referenceTargetSources: [],
      showInTable: false,
      isSearchable: false,
      isSortable: false,
      enumOptions: [option],
    },
  };
}

function valueWith(option: CustomFieldEnumOption): CustomFieldValueDetail {
  return {
    id: "v1",
    customFieldId: "field-1",
    entityId: "proj-1",
    name: "Priority",
    fieldType: CustomFieldType.Enum,
    displayValue: option.name,
    showInTable: false,
    textValue: null,
    numberValue: null,
    dateValue: null,
    enumValue: option,
    multiEnumValues: [],
    peopleValues: [],
    referenceValues: [],
  };
}
