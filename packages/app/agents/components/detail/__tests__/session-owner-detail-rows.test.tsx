import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import {
  CollaboratorArtifactType,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { DetailsFieldId } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import {
  resolveTimelineOwnerLabel,
  TIMELINE_STACK_GROUPINGS,
  TimelineStackGrouping,
  UNKNOWN_OWNER_LABEL,
} from "../../../lib/session-timeline-stacks";
import {
  SESSION_ASSIGNEE_FIXTURE,
  SESSION_CREATOR_FIXTURE,
  SESSION_UPLOADER_FIXTURE,
} from "../../sessions/session-list-fixtures";
import {
  createAgentSessionDetailFixture,
  withProducerBinBounds,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import { SessionPropertiesPanel } from "../session-properties-panel";
import { sessionShellDetailsConfig } from "../session-shell-details";
import { withProviders } from "./agent-session-detail-view.test-helpers";

/**
 * ISS-12251 (PLN-2176 T-4.4): the session detail's Owner readers — the
 * Properties panel row, the Details tab row and the timeline's "Session Owner"
 * grouping — read the assignee (D-1; operator ruling 2026-10-13). Assignee,
 * recording user and creator are three different people, so a reader still on
 * `user` or `createdBy` fails.
 *
 * AC-012: a producer that OMITS `assignee` (an older API)
 * renders as before, on `user`; a present `null` is unassigned.
 */

const PROPERTIES_DISCLOSURE_NAME = /Properties/i;
const GROUP_BY_NAME = /group by/i;
const OWNER_GROUPING_LABEL =
  TIMELINE_STACK_GROUPINGS.find(
    (grouping) => grouping.value === TimelineStackGrouping.Owner
  )?.label ?? "";

const ASSIGNEE_NAME = "Ada Lovelace";
const UPLOADER_NAME = "Sam Uploader";

const assigned = createAgentSessionDetailFixture({
  assignee: SESSION_ASSIGNEE_FIXTURE,
  createdBy: SESSION_CREATOR_FIXTURE,
  user: SESSION_UPLOADER_FIXTURE,
});
const unassigned = createAgentSessionDetailFixture({
  assignee: null,
  createdBy: SESSION_CREATOR_FIXTURE,
  user: SESSION_UPLOADER_FIXTURE,
});
const omitted = createAgentSessionDetailFixture({
  createdBy: SESSION_CREATOR_FIXTURE,
  user: SESSION_UPLOADER_FIXTURE,
});

const SESSION_START_MS = Date.parse("2026-06-10T00:00:00.000Z");
const SESSION_END_MS = SESSION_START_MS + 40 * 60_000;

/** Bins that state their clock, so the strip resolves and offers "Group by". */
const timelineSession = createAgentSessionDetailFixture({
  activityBuckets: withProducerBinBounds(
    Array.from({ length: 8 }, (_, index) => ({
      byModel: { "claude-opus-5": { cCache: 0.5, cIn: 1, cOut: 0.5 } },
      cCache: 0.5,
      cIn: 1,
      cOut: 0.5,
      key: `bin-${index}`,
      label: `bin ${index}`,
      tl0: index,
      toolStart: 1,
      total: 2,
    })),
    { endMs: SESSION_END_MS, startMs: SESSION_START_MS }
  ),
  activitySegmentRows: [
    {
      confidence: 1,
      endMs: SESSION_END_MS,
      evidenceLayers: ["declared"],
      phase: "implement",
      startMs: SESSION_START_MS,
      version: 1,
    },
  ],
  assignee: SESSION_ASSIGNEE_FIXTURE,
  createdBy: SESSION_CREATOR_FIXTURE,
  endedAt: new Date(SESSION_END_MS),
  lastActivityAt: new Date(SESSION_END_MS),
  startedAt: new Date(SESSION_START_MS),
  status: SESSION_STATUS.INACTIVE,
  user: SESSION_UPLOADER_FIXTURE,
});

async function propertiesOwnerRow(session: AgentSessionDetail) {
  render(
    <AppCoreStoryProviders>
      <SessionPropertiesPanel session={session} />
    </AppCoreStoryProviders>
  );
  await userEvent.click(
    screen.getByRole("button", { name: PROPERTIES_DISCLOSURE_NAME })
  );
  return screen.getByText("Owner", { exact: true }).closest(".prd-prop");
}

function detailsOwnerValue(session: AgentSessionDetail) {
  const config = sessionShellDetailsConfig(
    { displayedStatus: SESSION_STATUS.INACTIVE, session },
    unavailableArtifactCollaborators(CollaboratorArtifactType.Session)
  );
  return config.core.find((field) => field.id === DetailsFieldId.Owner)?.value;
}

describe("Properties panel Owner reads the assignee (ISS-12251 T-4.4)", () => {
  it("shows the assignee, not the recording user", async () => {
    const row = await propertiesOwnerRow(assigned);
    expect(row).toHaveTextContent(ASSIGNEE_NAME);
    expect(row).not.toHaveTextContent(UPLOADER_NAME);
  });

  it("shows the recording user when the producer omits assignee (AC-012)", async () => {
    const row = await propertiesOwnerRow(omitted);
    expect(row).toHaveTextContent(UPLOADER_NAME);
  });

  it("shows the empty value for an unassigned session", async () => {
    const row = await propertiesOwnerRow(unassigned);
    expect(row).not.toHaveTextContent(UPLOADER_NAME);
    expect(row?.querySelector('[data-slot="grid-empty-value"]')).not.toBeNull();
  });
});

describe("Details tab Owner reads the assignee (ISS-12251 T-4.4)", () => {
  it("names the assignee, not the recording user", () => {
    expect(detailsOwnerValue(assigned)).toMatchObject({
      kind: "person",
      name: ASSIGNEE_NAME,
    });
  });

  it("is empty for an unassigned session, so the row is not drawn", () => {
    expect(detailsOwnerValue(unassigned)).toEqual({ kind: "text", text: "" });
  });
});

describe("timeline Session Owner grouping reads the assignee (ISS-12251)", () => {
  it("labels the mounted owner cut with the assignee, not the recording user", async () => {
    const user = userEvent.setup();
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={timelineSession}
        />
      )
    );
    screen.getByRole("combobox", { name: GROUP_BY_NAME }).focus();
    await user.keyboard("{Enter}");
    await user.click(
      await screen.findByRole("option", { name: OWNER_GROUPING_LABEL })
    );

    // A bar's accessible name folds in its segment labels (ISS-5819).
    expect(
      screen.getAllByRole("button", {
        name: (name) => name.includes(ASSIGNEE_NAME),
      })
    ).not.toHaveLength(0);
    expect(
      screen.queryAllByRole("button", {
        name: (name) => name.includes(UPLOADER_NAME),
      })
    ).toHaveLength(0);
  });

  it("labels the owner cut with the assignee, the user only when it is omitted", () => {
    expect(resolveTimelineOwnerLabel(assigned)).toBe(ASSIGNEE_NAME);
    expect(resolveTimelineOwnerLabel(omitted)).toBe(UPLOADER_NAME);
    expect(resolveTimelineOwnerLabel(unassigned)).toBe(UNKNOWN_OWNER_LABEL);
  });
});
