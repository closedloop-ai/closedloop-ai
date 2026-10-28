/**
 * ISS-8214 — a reference picker must not offer the entity that owns the value.
 *
 * `resolveAndValidateReferenceTargets` rejects a target equal to the owning
 * entity, so the option could only ever fail to save. The corpus below carries
 * the owner AND three siblings on purpose: with one target, "the owner is
 * absent" is satisfied by a picker that lists nothing at all, and every case
 * here asserts the siblings are still offered in the same breath.
 */

import { ArtifactType } from "@repo/api/src/types/artifact";
import type {
  CustomFieldReferenceSearchResponse,
  CustomFieldReferenceTarget,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import { CUSTOM_FIELD_EDITOR_CONTRACTS_FLAG_KEY } from "@repo/api/src/types/custom-field-editor-contracts-flag";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomFieldTableCell } from "../custom-field-table-cell";

const OWNER_ID = "session-owner";

afterEach(cleanup);

describe("reference custom-field picker owner exclusion", () => {
  it("offers every other target and never the row that owns the value", async () => {
    await openPicker({ flagEnabled: true });

    expect(screen.queryByText("SESS-1")).not.toBeInTheDocument();
    expect(screen.getByText("SESS-2")).toBeInTheDocument();
    expect(screen.getByText("SESS-3")).toBeInTheDocument();
    expect(screen.getByText("SESS-4")).toBeInTheDocument();
  });

  it("without the gate still offers the owning row, which is the defect", async () => {
    await openPicker({ flagEnabled: false });

    expect(screen.getByText("SESS-1")).toBeInTheDocument();
    expect(screen.getByText("SESS-2")).toBeInTheDocument();
    expect(screen.getByText("SESS-3")).toBeInTheDocument();
    expect(screen.getByText("SESS-4")).toBeInTheDocument();
  });

  it("excludes the owner from a multi-reference picker too", async () => {
    await openPicker({
      fieldType: CustomFieldType.ReferenceMulti,
      flagEnabled: true,
    });

    expect(screen.queryByText("SESS-1")).not.toBeInTheDocument();
    expect(screen.getByText("SESS-2")).toBeInTheDocument();
    expect(screen.getByText("SESS-4")).toBeInTheDocument();
  });

  it("selecting a sibling still reports that sibling's id", async () => {
    const onValueChange = await openPicker({ flagEnabled: true });

    await userEvent.click(screen.getByText("SESS-3"));

    expect(onValueChange).toHaveBeenCalledWith("session-3");
  });

  it("excludes the owner from server-returned targets, not just static ones", async () => {
    await openPicker({
      flagEnabled: true,
      loadReferenceOptions: () =>
        Promise.resolve({ hasMore: false, targets: [...REFERENCE_TARGETS] }),
    });

    expect(await screen.findByText("SESS-2")).toBeInTheDocument();
    expect(screen.queryByText("SESS-1")).not.toBeInTheDocument();
    expect(screen.getByText("SESS-3")).toBeInTheDocument();
    expect(screen.getByText("SESS-4")).toBeInTheDocument();
  });
});

async function openPicker({
  fieldType = CustomFieldType.Reference,
  flagEnabled,
  loadReferenceOptions,
}: {
  fieldType?: CustomFieldType;
  flagEnabled: boolean;
  loadReferenceOptions?: (
    query: string
  ) => Promise<CustomFieldReferenceSearchResponse>;
}) {
  const onValueChange = vi.fn();
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: flagEnabled
          ? [CUSTOM_FIELD_EDITOR_CONTRACTS_FLAG_KEY]
          : [],
      })}
    >
      <CustomFieldTableCell
        field={{ ...REFERENCE_FIELD, fieldType }}
        itemLabel="Session one"
        loadReferenceOptions={loadReferenceOptions}
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ID}
        referenceOptions={loadReferenceOptions ? undefined : REFERENCE_TARGETS}
      />
    </FeatureFlagAdapterProvider>
  );

  await userEvent.click(
    screen.getByRole("button", { name: "Edit Related session for Session one" })
  );
  return onValueChange;
}

function sessionTarget(
  id: string,
  slug: string,
  name: string
): CustomFieldReferenceTarget {
  return {
    artifactType: ArtifactType.Session,
    id,
    name,
    slug,
    status: "active",
    subtype: null,
  };
}

/** The owning row first, so an off-by-one filter cannot pass by luck. */
const REFERENCE_TARGETS: readonly CustomFieldReferenceTarget[] = [
  sessionTarget(OWNER_ID, "SESS-1", "Refactor the ledger"),
  sessionTarget("session-2", "SESS-2", "Add the sync cursor"),
  sessionTarget("session-3", "SESS-3", "Fix the fold damping"),
  sessionTarget("session-4", "SESS-4", "Trim the boot import"),
];

const REFERENCE_FIELD: CustomFieldWithOptions = {
  createdAt: new Date("2026-08-25T12:00:00.000Z"),
  createdById: "user-1",
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  description: null,
  entityTypes: [CustomFieldEntityType.Session],
  enumOptions: [],
  fieldType: CustomFieldType.Reference,
  id: "related-session",
  isGlobalToOrg: false,
  isSearchable: true,
  isSortable: true,
  name: "Related session",
  numberFormat: null,
  organizationId: "org-1",
  precision: null,
  referenceTargetSources: [ReferenceTargetSource.Session],
  showInTable: true,
  updatedAt: new Date("2026-08-25T12:00:00.000Z"),
};
