import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DATA_SYNC_LEVEL_COPY } from "../../lib/data-sync-copy";
import { DataSyncLevelPicker } from "../data-sync-level-picker";

/**
 * The in-flight lock (ISS-8366). A surface holding this control while a write
 * is in flight used to dim it with `pointer-events-none`, which stops a mouse
 * and lets a keyboard straight through: Radix's roving-tabindex group still
 * fired `onSelect` on an arrow key, so the lock was real for one input mode and
 * decorative for the other.
 */

const OFFERED = [DataSyncLevel.Off, DataSyncLevel.Metadata] as const;

function renderPicker(disabled: boolean) {
  const onSelect = vi.fn();
  render(
    <DataSyncLevelPicker
      disabled={disabled}
      label="Sync level for this device"
      levels={OFFERED}
      onSelect={onSelect}
      selected={DataSyncLevel.Off}
    />
  );
  return onSelect;
}

describe("DataSyncLevelPicker in-flight lock", () => {
  it("refuses a selection while disabled", () => {
    const onSelect = renderPicker(true);

    fireEvent.click(
      screen.getByRole("radio", {
        name: DATA_SYNC_LEVEL_COPY[DataSyncLevel.Metadata].title,
      })
    );

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("accepts the same selection when it is not disabled", () => {
    // Without this the case above would pass on a picker that never reports a
    // selection at all.
    const onSelect = renderPicker(false);

    fireEvent.click(
      screen.getByRole("radio", {
        name: DATA_SYNC_LEVEL_COPY[DataSyncLevel.Metadata].title,
      })
    );

    expect(onSelect).toHaveBeenCalledWith(DataSyncLevel.Metadata);
  });
});
