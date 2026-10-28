import {
  DATA_SYNC_LEVELS,
  DataSyncLevel,
} from "@repo/api/src/types/data-sync-level";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findDataSyncLevelCopy } from "../../lib/data-sync-copy";
import { DataSyncPolicySummary } from "../data-sync-policy-summary";

/**
 * ISS-12525. Labels and names here are test fixtures, not product copy: the
 * component takes every new string from its host.
 */
const DIRECTORY_LABEL = "fixture-directories";
const APPLIES_TO_LABEL = "fixture-applies-to";
const MACHINE = "fixture-machine";
const ORG = "fixture-org";
/** ISS-12523 shipped copy; the presence and absence assertions share it. */
const CURRENT_LEVEL = "Current level";

/** The markup ISS-12523 shipped, before the summary took any optional props. */
function shippedMarkup(level: DataSyncLevel | null): string {
  return renderToStaticMarkup(
    level === null ? (
      <p className="text-muted-foreground text-sm">
        This device has not saved a sync choice yet. Choose a level below, then
        save it for this workspace.
      </p>
    ) : (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Current level</span>
        <span>{findDataSyncLevelCopy(level).badgeLabel}</span>
      </div>
    )
  );
}

describe("ISS-12525 data sync policy summary", () => {
  it.each([null, ...DATA_SYNC_LEVELS])(
    "renders the shipped markup for level %s when no optional props are passed",
    (level) => {
      expect(
        renderToStaticMarkup(<DataSyncPolicySummary level={level} />)
      ).toBe(shippedMarkup(level));
    }
  );

  it("renders the shipped markup when appliesTo carries no name", () => {
    expect(
      renderToStaticMarkup(
        <DataSyncPolicySummary
          appliesTo={{ label: APPLIES_TO_LABEL, machineName: "", orgName: "" }}
          level={DataSyncLevel.Off}
        />
      )
    ).toBe(shippedMarkup(DataSyncLevel.Off));
  });

  it.each([0, 1, 12])("shows a directory count of %i beside its label", (n) => {
    render(
      <DataSyncPolicySummary
        directoryScope={{ label: DIRECTORY_LABEL, count: n }}
        level={DataSyncLevel.Metadata}
      />
    );
    expect(screen.getByText(DIRECTORY_LABEL).parentElement).toHaveTextContent(
      `${DIRECTORY_LABEL}${n}`
    );
    expect(screen.getByText(CURRENT_LEVEL)).toBeVisible();
  });

  it("shows the machine alone", () => {
    render(
      <DataSyncPolicySummary
        appliesTo={{ label: APPLIES_TO_LABEL, machineName: MACHINE }}
        level={DataSyncLevel.Full}
      />
    );
    const row = screen.getByText(APPLIES_TO_LABEL).parentElement;
    expect(row).toHaveTextContent(`${APPLIES_TO_LABEL}${MACHINE}`);
    expect(row).not.toHaveTextContent("·");
  });

  it("shows the organization alone", () => {
    render(
      <DataSyncPolicySummary
        appliesTo={{ label: APPLIES_TO_LABEL, orgName: ORG }}
        level={DataSyncLevel.Full}
      />
    );
    expect(screen.getByText(APPLIES_TO_LABEL).parentElement).toHaveTextContent(
      `${APPLIES_TO_LABEL}${ORG}`
    );
  });

  it("shows machine then organization, with a decorative separator", () => {
    render(
      <DataSyncPolicySummary
        appliesTo={{
          label: APPLIES_TO_LABEL,
          machineName: MACHINE,
          orgName: ORG,
        }}
        level={DataSyncLevel.Full}
      />
    );
    const row = screen.getByText(APPLIES_TO_LABEL).parentElement;
    expect(row).toHaveTextContent(`${APPLIES_TO_LABEL}${MACHINE}·${ORG}`);
    expect(screen.getByText("·")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders only the shipped unset message when scope and machine are passed", () => {
    expect(
      renderToStaticMarkup(
        <DataSyncPolicySummary
          appliesTo={{ label: APPLIES_TO_LABEL, machineName: MACHINE }}
          directoryScope={{ label: DIRECTORY_LABEL, count: 3 }}
          level={null}
        />
      )
    ).toBe(shippedMarkup(null));
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 2.5])(
    "drops the directory row for a count of %s",
    (count) => {
      expect(
        renderToStaticMarkup(
          <DataSyncPolicySummary
            directoryScope={{ label: DIRECTORY_LABEL, count }}
            level={DataSyncLevel.Metadata}
          />
        )
      ).toBe(shippedMarkup(DataSyncLevel.Metadata));
    }
  );

  it("keeps the applies-to row when only the directory count is bad", () => {
    render(
      <DataSyncPolicySummary
        appliesTo={{ label: APPLIES_TO_LABEL, machineName: MACHINE }}
        directoryScope={{ label: DIRECTORY_LABEL, count: Number.NaN }}
        level={DataSyncLevel.Full}
      />
    );
    expect(screen.queryByText(DIRECTORY_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText("NaN")).not.toBeInTheDocument();
    expect(screen.getByText(MACHINE)).toBeVisible();
  });

  it("treats a whitespace-only machine or organization name as absent", () => {
    expect(
      renderToStaticMarkup(
        <DataSyncPolicySummary
          appliesTo={{
            label: APPLIES_TO_LABEL,
            machineName: "   ",
            orgName: "\t",
          }}
          level={DataSyncLevel.Off}
        />
      )
    ).toBe(shippedMarkup(DataSyncLevel.Off));
  });

  it("trims a padded machine name and drops a blank organization", () => {
    render(
      <DataSyncPolicySummary
        appliesTo={{
          label: APPLIES_TO_LABEL,
          machineName: `  ${MACHINE}  `,
          orgName: " ",
        }}
        level={DataSyncLevel.Full}
      />
    );
    const row = screen.getByText(APPLIES_TO_LABEL).parentElement;
    expect(row).toHaveTextContent(`${APPLIES_TO_LABEL}${MACHINE}`);
    expect(row).not.toHaveTextContent("·");
  });
});
