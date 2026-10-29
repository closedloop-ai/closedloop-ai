import { DocumentStatus, IssueStatus } from "@closedloop-ai/loops-api/document";
import {
  artifactStatusLabels,
  DocumentStatusBadge,
  IssueStatusBadge,
} from "@repo/app/shared/components/status-badge";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  DOCUMENT_STATUS_LABELS,
  ISSUE_STATUS_LABELS,
} from "@repo/app/shared/lib/artifact-status-labels";
import { ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

/**
 * ISS-9560. Hand-written rather than read back out of the display module the
 * badges resolve it from — see the note in
 * `documents/components/__tests__/artifact-status-unknown-icon-name.test.tsx`.
 */
const UNKNOWN_STATUS_WORD = "Unknown";

// Reachable: `Artifact.status` is a freeform column and this response is not
// schema-validated, so a version-skewed or branch/session row arrives with a
// status in neither artifact vocabulary.
const UNRECOGNIZED_STATUS = "BRANCH_MERGED";

function gated(ui: ReactElement) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY],
      })}
    >
      {ui}
    </FeatureFlagAdapterProvider>
  );
}

/**
 * The badge's own class list. `FeatureFlagAdapterProvider` renders no DOM node,
 * so the badge is the container's only element under either gate.
 */
function badgeClassName(ui: ReactElement, gate: "open" | "shut"): string {
  const { container } = gate === "open" ? gated(ui) : render(ui);
  const badge = container.firstElementChild;
  if (!badge) {
    throw new Error("badge did not render");
  }
  return badge.className;
}

describe("one label declaration per status vocabulary", () => {
  it("re-binds the canonical Document map rather than holding a second copy", () => {
    // IDENTITY, not deep equality, and that is the whole point: the declaration
    // this replaced was a VERBATIM copy of DOCUMENT_STATUS_LABELS, so every
    // value-comparing assertion stayed green while two declarations existed to
    // drift apart. Only object identity can tell a re-bind from a copy.
    expect(artifactStatusLabels).toBe(DOCUMENT_STATUS_LABELS);
  });
});

describe("the status badges' answer for a status this build does not recognize", () => {
  it("renders the honest word on a Document badge when the gate is open", () => {
    gated(
      <DocumentStatusBadge status={UNRECOGNIZED_STATUS as DocumentStatus} />
    );

    expect(screen.getByText(UNKNOWN_STATUS_WORD)).toBeInTheDocument();
    expect(screen.queryByText(UNRECOGNIZED_STATUS)).toBeNull();
  });

  it("renders the honest word on an Issue badge when the gate is open", () => {
    gated(<IssueStatusBadge status={UNRECOGNIZED_STATUS as IssueStatus} />);

    expect(screen.getByText(UNKNOWN_STATUS_WORD)).toBeInTheDocument();
    expect(screen.queryByText(UNRECOGNIZED_STATUS)).toBeNull();
  });

  it("keeps printing the raw wire token while the gate is shut", () => {
    render(
      <DocumentStatusBadge status={UNRECOGNIZED_STATUS as DocumentStatus} />
    );

    expect(screen.getByText(UNRECOGNIZED_STATUS)).toBeInTheDocument();
    expect(screen.queryByText(UNKNOWN_STATUS_WORD)).toBeNull();
  });

  it("still renders a recognized status in its own words when the gate is open", () => {
    // The gate changes the MISS path only. Without this, deleting the map
    // lookup entirely and always rendering "Unknown" would pass every
    // assertion above.
    gated(
      <DocumentStatusBadge status={"CHANGES_REQUESTED" as DocumentStatus} />
    );

    expect(screen.getByText("Changes Requested")).toBeInTheDocument();
    expect(screen.queryByText(UNKNOWN_STATUS_WORD)).toBeNull();
  });
});

/**
 * The COLOR half. The label assertions above all passed while the badge still
 * wore Draft's exact tokens, which is how that shipped to review: the word said
 * "Unknown" and the chip said Draft (PR #6973). Asserting the class list against
 * a REAL badge of the state it must not impersonate is what pins it — a literal
 * token string here would keep passing the moment either palette moved.
 */
describe("an unrecognized status is not dressed as a status this build knows", () => {
  it("parts a Document badge from Draft when the gate is open", () => {
    const unknown = badgeClassName(
      <DocumentStatusBadge status={UNRECOGNIZED_STATUS as DocumentStatus} />,
      "open"
    );
    const draft = badgeClassName(
      <DocumentStatusBadge status={DocumentStatus.Draft} />,
      "open"
    );

    expect(unknown).not.toBe(draft);
  });

  it("parts an Issue badge from Backlog when the gate is open", () => {
    const unknown = badgeClassName(
      <IssueStatusBadge status={UNRECOGNIZED_STATUS as IssueStatus} />,
      "open"
    );
    const backlog = badgeClassName(
      <IssueStatusBadge status={IssueStatus.Backlog} />,
      "open"
    );

    expect(unknown).not.toBe(backlog);
    expect(
      screen.getByText(ISSUE_STATUS_LABELS[IssueStatus.Backlog])
    ).toBeInTheDocument();
  });

  it("keeps the pre-flag Draft treatment on a Document badge while the gate is shut", () => {
    // The closed default must render exactly what it rendered before ISS-9560,
    // colors included — without this the fix above could quietly change what
    // every user currently sees.
    const unknown = badgeClassName(
      <DocumentStatusBadge status={UNRECOGNIZED_STATUS as DocumentStatus} />,
      "shut"
    );
    const draft = badgeClassName(
      <DocumentStatusBadge status={DocumentStatus.Draft} />,
      "shut"
    );

    expect(unknown).toBe(draft);
  });

  it("keeps the pre-flag Backlog treatment on an Issue badge while the gate is shut", () => {
    const unknown = badgeClassName(
      <IssueStatusBadge status={UNRECOGNIZED_STATUS as IssueStatus} />,
      "shut"
    );
    const backlog = badgeClassName(
      <IssueStatusBadge status={IssueStatus.Backlog} />,
      "shut"
    );

    expect(unknown).toBe(backlog);
  });

  it("leaves a recognized status wearing its own treatment when the gate is open", () => {
    // Without this, painting EVERY badge with the unknown treatment would pass
    // both parting assertions above.
    const approved = badgeClassName(
      <DocumentStatusBadge status={DocumentStatus.Approved} />,
      "open"
    );
    const unknown = badgeClassName(
      <DocumentStatusBadge status={UNRECOGNIZED_STATUS as DocumentStatus} />,
      "open"
    );

    expect(approved).not.toBe(unknown);
    expect(
      screen.getByText(DOCUMENT_STATUS_LABELS[DocumentStatus.Approved])
    ).toBeInTheDocument();
  });

  it("gives both vocabularies the same unknown treatment", () => {
    // One statement of "this build cannot read that status", not a per-badge
    // invention: the Document and Issue badges resolve through one helper and
    // must land on one answer.
    const documentUnknown = badgeClassName(
      <DocumentStatusBadge status={UNRECOGNIZED_STATUS as DocumentStatus} />,
      "open"
    );
    const issueUnknown = badgeClassName(
      <IssueStatusBadge status={UNRECOGNIZED_STATUS as IssueStatus} />,
      "open"
    );

    expect(documentUnknown).toBe(issueUnknown);
  });
});
