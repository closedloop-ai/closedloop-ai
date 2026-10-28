import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildComputeTargetFixture } from "../../../settings/v2/test-fixtures/device-panel-fixtures";
import { ComputeTargetRow } from "../compute-target-row";

/**
 * The ownership predicate (PLN-1915 D4), asserted through its EFFECT.
 *
 * `/compute-targets/{id}` DELETE is a `deleteOwned` write, and the list marks a
 * target the viewer does not own by populating `ownerName`. Every case below therefore renders the SAME fixture
 * twice, differing only in that field, so a case can only pass because of the
 * predicate rather than because of some other difference between two hand-built
 * targets.
 *
 * Counting controls would not do: a disabled control and no control are the
 * same count and different products. These assert the control is ABSENT.
 */

const OTHER_OWNER = "Grace Hopper";

const UPDATE_SLOT = "Caller's update slot";

const DELETE_LABEL = "Delete";

function renderRow(target: ComputeTarget) {
  return render(
    <ComputeTargetRow
      desktopUpdateUrl={null}
      isDesktopReleaseLoading={false}
      target={target}
      updateAction={<span>{UPDATE_SLOT}</span>}
    />
  );
}

describe("ComputeTargetRow ownership predicate", () => {
  it("offers Delete and the update slot for a target with no ownerName", () => {
    renderRow(buildComputeTargetFixture());

    // An owned row offers no share-with-team switch (ISS-12617).
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: DELETE_LABEL })
    ).toBeInTheDocument();
    expect(screen.getByText(UPDATE_SLOT)).toBeInTheDocument();
  });

  it("withholds both for the SAME target once ownerName is present", () => {
    // Not disabled controls: they must not be on screen at all, or the row
    // offers a write the server answers with a refusal.
    renderRow(buildComputeTargetFixture({ ownerName: OTHER_OWNER }));

    expect(
      screen.queryByRole("button", { name: DELETE_LABEL })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(UPDATE_SLOT)).not.toBeInTheDocument();
  });

  it("renders the machine name for a target the viewer does not own", () => {
    // Ownership withholds the WRITES, not the row. A target an older API lists
    // for another member is still a machine the viewer can be told about.
    renderRow(buildComputeTargetFixture({ ownerName: OTHER_OWNER }));

    expect(screen.getByText("Ada-MBP")).toBeInTheDocument();
  });
});
