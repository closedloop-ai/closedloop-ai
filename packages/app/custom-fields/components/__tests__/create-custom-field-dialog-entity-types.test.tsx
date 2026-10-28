/**
 * ISS-7209 — the "Applies to" selector is derived from `CustomFieldEntityType`,
 * so SESSION and BRANCH would surface the moment the enum grew. This pins the
 * closed-by-default gate (ISS-4779): off, the two new choices are absent and the
 * two existing ones are untouched; on, all four are offered.
 */
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../shared/feature-flags/provider";
import {
  CreateCustomFieldDialog,
  CUSTOM_FIELD_SESSION_BRANCH_ENTITY_TYPES_FEATURE_FLAG_KEY,
} from "../create-custom-field-dialog";

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useCreateCustomField: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateCustomField: () => ({ mutate: vi.fn(), isPending: false }),
}));

const PROJECTS_RE = /^Projects$/;
const DOCUMENTS_RE = /^Documents$/;
const SESSIONS_RE = /^Sessions$/;
const BRANCHES_RE = /^Branches$/;

function renderDialog(enabledFlags: readonly string[]) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <CreateCustomFieldDialog
        field={undefined}
        onOpenChange={vi.fn()}
        open={true}
      />
    </FeatureFlagAdapterProvider>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("CreateCustomFieldDialog — Session and Branch entity types are gated", () => {
  it("offers only Projects and Documents with the flag off", () => {
    renderDialog([]);

    expect(screen.getByRole("checkbox", { name: PROJECTS_RE })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: DOCUMENTS_RE })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: SESSIONS_RE })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: BRANCHES_RE })).toBeNull();
  });

  it("offers Sessions and Branches with the flag on", () => {
    renderDialog([CUSTOM_FIELD_SESSION_BRANCH_ENTITY_TYPES_FEATURE_FLAG_KEY]);

    expect(screen.getByRole("checkbox", { name: SESSIONS_RE })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: BRANCHES_RE })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: PROJECTS_RE })).toBeTruthy();
  });

  it("stays closed when no flag provider is mounted at all", () => {
    render(
      <CreateCustomFieldDialog
        field={undefined}
        onOpenChange={vi.fn()}
        open={true}
      />
    );

    expect(screen.queryByRole("checkbox", { name: SESSIONS_RE })).toBeNull();
  });
});
