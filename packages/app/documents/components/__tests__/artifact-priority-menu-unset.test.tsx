/**
 * ISS-9665 — the "No priority" item in the shared artifact priority menu.
 *
 * Two facts have to hold together and neither implies the other: the item
 * appears ONLY with `ARTIFACT_PRIORITY_UNSET_FLAG_KEY` on (the closed-by-default
 * UI policy), and ONLY on a row whose entity can actually hold "no priority".
 * Since ISS-9441 both supported surfaces — artifacts and projects — answer yes,
 * so the capability's OFF case is no longer reachable from a shipped caller; it
 * is still asserted below, because it is what keeps the gate and the capability
 * from collapsing into one boolean.
 *
 * The flag mock is driven per case rather than pinned once, so the OFF path is
 * exercised by an assertion that would fail if the item rendered unconditionally
 * — a test that only ever ran with the gate shut would pass against a menu that
 * never grew the item at all.
 */
import { Priority } from "@repo/api/src/types/common";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockFlagEnabled = vi.fn();

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: (key: string) => mockFlagEnabled(key),
}));

import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import { NO_PRIORITY_LABEL } from "@repo/app/documents/lib/group-by";
import { ArtifactPriorityMenu } from "../artifact-field-menus";

beforeEach(() => {
  mockFlagEnabled.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

async function openMenu(
  onSelect: (priority: Priority | null) => void,
  allowUnset: boolean
) {
  render(
    <ArtifactPriorityMenu
      allowUnset={allowUnset}
      onSelect={onSelect}
      trigger={<button type="button">Open priority</button>}
    />
  );
  await userEvent.click(screen.getByRole("button", { name: "Open priority" }));
}

describe("ArtifactPriorityMenu — unset item", () => {
  test("offers it, and selecting it clears the priority, when the flag is on", async () => {
    mockFlagEnabled.mockReturnValue(true);
    const onSelect = vi.fn();

    await openMenu(onSelect, true);
    await userEvent.click(
      await screen.findByRole("menuitem", { name: NO_PRIORITY_LABEL })
    );

    // The handler receives `null` — the value that CLEARS the column — not a
    // string sentinel the write path would try to persist as a Priority.
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(mockFlagEnabled).toHaveBeenCalledWith(
      ARTIFACT_PRIORITY_UNSET_FLAG_KEY
    );
  });

  test("does not offer it when the flag is off", async () => {
    mockFlagEnabled.mockReturnValue(false);

    await openMenu(vi.fn(), true);

    expect(
      screen.queryByRole("menuitem", { name: NO_PRIORITY_LABEL })
    ).toBeNull();
    // The positive sibling: the menu still renders, so the assertion above is
    // about the unset item and not about a menu that failed to open.
    expect(
      await screen.findByRole("menuitem", { name: "Urgent" })
    ).toBeInTheDocument();
  });

  test("does not offer it for a row that cannot hold an unset priority", async () => {
    // Flag ON, capability OFF. Separating the two is what proves the gate is not
    // doing the capability's job — with both supported surfaces now clearable,
    // collapsing them would leave nothing checking that `allowUnset` is read at
    // all, and the next unsupported surface would inherit the item.
    mockFlagEnabled.mockReturnValue(true);

    await openMenu(vi.fn(), false);

    expect(
      screen.queryByRole("menuitem", { name: NO_PRIORITY_LABEL })
    ).toBeNull();
    expect(
      await screen.findByRole("menuitem", { name: "Urgent" })
    ).toBeInTheDocument();
  });

  test("still sets a real priority with the flag on", async () => {
    mockFlagEnabled.mockReturnValue(true);
    const onSelect = vi.fn();

    await openMenu(onSelect, true);
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "High" })
    );

    expect(onSelect).toHaveBeenCalledWith(Priority.High);
  });
});
