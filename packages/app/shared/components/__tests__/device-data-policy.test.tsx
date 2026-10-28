/**
 * ISS-12531 — `DeviceDataPolicy`: a device's reported level and scope shown
 * read-only (AC-001), the not-reported state (AC-002), and no edit control
 * anywhere (AC-003).
 *
 * The copy below is test-only wording; the component owns no new strings.
 * "Current level" and the level badge labels are ISS-12523's shipped copy.
 */

import {
  DATA_SYNC_LEVELS,
  DataSyncLevel,
} from "@repo/api/src/types/data-sync-level";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { findDataSyncLevelCopy } from "../../lib/data-sync-copy";
import {
  DeviceDataPolicy,
  type DeviceDataPolicyCopy,
  type DeviceReportedDataPolicy,
} from "../device-data-policy";

const COPY: DeviceDataPolicyCopy = {
  appliesTo: "fixture-applies-to",
  directoryScope: "fixture-directories",
  reported: "fixture-reported",
  scopeList: {
    autoExcludedHeading: "fixture-auto-heading",
    autoExcludedReason: "fixture-auto-reason",
    empty: "fixture-empty",
    newlyDiscovered: "fixture-new",
    noSelection: "fixture-no-selection",
    treeLabel: "fixture-tree",
    unavailable: "fixture-offline",
    unavailableReason: "fixture-offline-reason",
  },
  scopeReadOnlyReason: "fixture-read-only",
  unreported: "fixture-unreported",
};

const MACHINE = "fixture-machine";
const ORG = "fixture-org";

const POLICY: DeviceReportedDataPolicy = {
  directoryCount: 2,
  level: DataSyncLevel.Full,
  scope: {
    autoExcluded: [{ id: "~/Documents", label: "~/Documents" }],
    entries: [
      {
        id: "~/code",
        label: "~/code",
        children: [{ id: "~/code/orbit-api", label: "orbit-api" }],
      },
      { id: "~/sandbox", label: "~/sandbox" },
    ],
    includedIds: ["~/code"],
  },
};

const EDIT_ROLES = ["button", "combobox", "radio", "checkbox", "textbox"];

/** ISS-12523 shipped copy: the device-local unset message asks for a choice. */
const DEVICE_LOCAL_UNSET_MESSAGE =
  /This device has not saved a sync choice yet/;

function renderPolicy(policy: DeviceReportedDataPolicy | null) {
  return render(
    <DeviceDataPolicy
      copy={COPY}
      machineName={MACHINE}
      orgName={ORG}
      policy={policy}
    />
  );
}

describe("DeviceDataPolicy reported policy (AC-001)", () => {
  it.each(DATA_SYNC_LEVELS)(
    "shows the %s level the device reported",
    (level) => {
      renderPolicy({ level });
      expect(screen.getByText("Current level")).toBeInTheDocument();
      expect(
        screen.getByText(findDataSyncLevelCopy(level).badgeLabel)
      ).toBeInTheDocument();
      expect(screen.getByRole("status", { name: COPY.reported })).toBeVisible();
    }
  );

  it("shows the directory count, machine and organization", () => {
    renderPolicy(POLICY);
    expect(
      screen.getByText(COPY.directoryScope).parentElement
    ).toHaveTextContent("2");
    const appliesTo = screen.getByText(COPY.appliesTo).parentElement;
    expect(appliesTo).toHaveTextContent(MACHINE);
    expect(appliesTo).toHaveTextContent(ORG);
  });

  it("shows the reported scope as a locked tree", () => {
    renderPolicy(POLICY);
    const tree = screen.getByRole("tree", { name: COPY.scopeList.treeLabel });
    const code = within(tree).getByRole("treeitem", { name: "~/code" });
    expect(code).toHaveAttribute("aria-checked", "true");
    expect(code).toHaveAttribute("data-readonly");
    expect(code).toHaveAccessibleDescription(COPY.scopeReadOnlyReason);
    expect(
      within(tree).getByRole("treeitem", { name: "~/sandbox" })
    ).toHaveAttribute("aria-checked", "false");
  });

  it("omits the count row and the tree when the device reported neither", () => {
    renderPolicy({ level: DataSyncLevel.Metadata });
    expect(screen.queryByText(COPY.directoryScope)).toBeNull();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("shows a reported count of 0 rather than dropping the row", () => {
    renderPolicy({ directoryCount: 0, level: DataSyncLevel.Off });
    expect(
      screen.getByText(COPY.directoryScope).parentElement
    ).toHaveTextContent("0");
  });
});

describe("DeviceDataPolicy no reported policy (AC-002)", () => {
  it("renders the unavailable state with the machine name and no level", () => {
    renderPolicy(null);
    const indicator = screen.getByTestId("policy-status-indicator");
    expect(indicator).toHaveAttribute("data-state", "unavailable");
    expect(
      screen.getByRole("status", { name: COPY.unreported })
    ).toBeInTheDocument();
    expect(screen.getByText(MACHINE)).toBeInTheDocument();
    expect(screen.queryByText("Current level")).toBeNull();
    expect(screen.queryByText(COPY.reported)).toBeNull();
  });

  it("never shows the device-local unset message, which asks for a choice", () => {
    renderPolicy(null);
    expect(screen.queryByText(DEVICE_LOCAL_UNSET_MESSAGE)).toBeNull();
  });
});

describe("DeviceDataPolicy offers no edit on web (AC-003)", () => {
  it.each(
    EDIT_ROLES.flatMap((role) => [
      ["reported", role, POLICY] as const,
      ["not reported", role, null] as const,
    ])
  )("when %s, renders no %s", (_label, role, policy) => {
    renderPolicy(policy);
    expect(screen.queryAllByRole(role)).toHaveLength(0);
  });

  it("keeps the reported scope unchanged after clicks and keys", () => {
    renderPolicy(POLICY);
    const tree = screen.getByRole("tree", { name: COPY.scopeList.treeLabel });
    const sandbox = within(tree).getByRole("treeitem", { name: "~/sandbox" });
    const code = within(tree).getByRole("treeitem", { name: "~/code" });
    fireEvent.click(sandbox);
    fireEvent.keyDown(code, { key: " " });
    expect(sandbox).toHaveAttribute("aria-checked", "false");
    expect(code).toHaveAttribute("aria-checked", "true");
  });
});
