/**
 * @file member-install-control.test.tsx
 * @description The RESIDUE of the member install cell (ISS-6699), scoped by
 * diffing against `member-targets-block.install.test.tsx`, which already drives
 * this control through `PackDetail` and covers the dispatch, the offline and
 * unsupported reasons, the per-cell disable, and the retryable /
 * non-retryable withdraw. Those cases are deliberately NOT repeated here.
 *
 * What the parent's fixtures cannot reach:
 *
 *  - the PENDING LABEL. The parent asserts `toBeDisabled()` and queries by
 *    accessible name, which is built from the action and never changes — so
 *    deleting the "Sending…" swap leaves every parent test green while the
 *    member gets no feedback at all between clicking and the node reporting.
 *  - the SETTLED state rendering nothing. The parent renders an `Installed`
 *    cell only as a bystander and asserts nothing about it, so rule 3 of the
 *    control's own contract ("nothing, for the settled states") is unpinned.
 *  - a blocked cell that ALSO carries a dispatch outcome. The control renders
 *    the outcome BENEATH whichever of the three renders; reading its docblock
 *    as "exactly one of three, never two" and making the outcome exclusive
 *    would pass every parent test and silently drop the member's only feedback.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PackInstallState } from "../../lib/install-state";
import { MemberInstallDispatchTone } from "../../lib/member-install-dispatch-copy";
import { MemberInstallControl } from "../member-install-control";

const INSTALL_NAME = "Install release-captain on Laptop for Claude";

function renderControl(
  props: Partial<Parameters<typeof MemberInstallControl>[0]> = {}
) {
  return render(
    <MemberInstallControl
      computeTargetName="Laptop"
      harnessLabel="Claude"
      onAction={vi.fn()}
      packName="release-captain"
      state={PackInstallState.NotInstalled}
      {...props}
    />
  );
}

describe("MemberInstallControl residue (ISS-6699)", () => {
  it("replaces the action word with Sending… while its own dispatch is in flight", () => {
    renderControl({ isPending: true });

    // The accessible name is built from the action and is unchanged — which is
    // exactly why the parent's name-based queries cannot see this swap.
    const button = screen.getByRole("button", { name: INSTALL_NAME });
    expect(button).toHaveTextContent("Sending…");
    expect(button).not.toHaveTextContent("Install");
  });

  it("renders nothing at all for a settled cell whose status line already says everything", () => {
    const { container } = renderControl({ state: PackInstallState.Installed });

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    // And no blocked-reason excuse either: `Installed` is settled, not blocked,
    // so the control renders an empty shell rather than an explanation nobody
    // asked for. Asserted on the element, not via a text query that a missing
    // node would satisfy anyway.
    expect(container.firstChild).toBeEmptyDOMElement();
  });

  it("keeps the dispatch outcome alongside a blocked cell's reason, not instead of it", () => {
    renderControl({
      state: PackInstallState.Offline,
      dispatch: {
        message: "Laptop is offline, so nothing was installed.",
        tone: MemberInstallDispatchTone.Danger,
        retryable: true,
      },
    });

    expect(
      screen.getByText(
        "Laptop is offline. Install state will sync when it reconnects."
      )
    ).toBeInTheDocument();
    expect(screen.getByTestId("member-install-dispatch")).toHaveTextContent(
      "Laptop is offline, so nothing was installed."
    );
  });
});
