import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { FileTextIcon } from "lucide-react";
import { expect, userEvent, within } from "storybook/test";
import type { DiagnosticsPayload } from "../lib/diagnostics-payload";
import { DiagnosticsSectionId } from "../lib/diagnostics-sections";
import {
  type DiagnosticsSource,
  DiagnosticsTransportStatus,
} from "../lib/diagnostics-source";
import {
  DIAGNOSTICS_SURFACE_DESCRIPTION,
  DiagnosticsSurfaceV2,
} from "./diagnostics-surface-v2";

/**
 * ISS-10004: one story per state of the Diagnostics ladder.
 *
 * Three of them look alike in a DOM assertion and nothing alike to a reader — a
 * probe still running, a probe that failed, and a probe that answered with
 * something this build cannot read. Conflating any two is how a diagnostics page
 * starts lying about the machine it was opened to explain.
 */
const meta = {
  component: DiagnosticsSurfaceV2,
  tags: ["deprecated", "autodocs"],
  title: "Composites v1.0/Diagnostics/Diagnostics Surface V2",
};

export default meta;

const AXIS_LABELS = {
  autonomy_band: "Autonomy",
  closedloop_user: "ClosedLoop user",
  harness: "Harness",
  length_band: "Session length",
};

const HEALTHY_PAYLOAD: DiagnosticsPayload = {
  backfill: {
    artifactLinks: {
      lastScannedAt: "2026-09-11T08:12:00.000Z",
      totalScanned: 1284,
    },
    prBackfill: { lastScannedAt: null, totalScanned: 0 },
  },
  linkStats: [
    { count: 412, method: "branch-name", relation: "implements" },
    { count: 97, method: "pr-body", relation: "implements" },
    { count: 12, method: "commit-trailer", relation: "references" },
  ],
  linkTotals: { linkedArtifacts: 310, linkedSessions: 268, totalLinks: 521 },
  repos: [
    {
      defaultBranch: "main",
      gitDir: "/Users/example/Web/closedloop-ai/.git",
      id: "repo-1",
      lastSeenAt: "2026-09-11T09:02:11.000Z",
      remoteUrl: "git@github.com:acme/closedloop-ai.git",
      repoFullName: "acme/closedloop-ai",
      worktreeCount: 4,
    },
    {
      defaultBranch: null,
      gitDir: "/Users/example/scratch/spike/.git",
      id: "repo-2",
      lastSeenAt: "2026-09-04T17:45:00.000Z",
      remoteUrl: null,
      repoFullName: null,
      worktreeCount: 1,
    },
  ],
};

function source(overrides: Partial<DiagnosticsSource> = {}): DiagnosticsSource {
  return {
    autoRefresh: { enabled: true, toggle: () => undefined },
    availableSections: [],
    errorMessage: null,
    onSectionChange: () => undefined,
    payload: HEALTHY_PAYLOAD,
    refresh: { busy: false, run: () => undefined },
    settledSections: [DiagnosticsSectionId.Withheld],
    status: DiagnosticsTransportStatus.Ready,
    unservableReason: null,
    ...overrides,
  };
}

/** Built by REMOVING the key, so the fixture is the shape a skewed producer sends. */
function withoutLinkTotals(payload: DiagnosticsPayload): DiagnosticsPayload {
  const skewed = { ...payload };
  Reflect.deleteProperty(skewed, "linkTotals");
  return skewed;
}

function LogsStandIn() {
  return (
    <div className="rounded border border-dashed p-6 text-[var(--muted-foreground)] text-sm">
      The host's log reader renders here.
    </div>
  );
}

function story(overrides: Partial<DiagnosticsSource> = {}) {
  return {
    render: () => (
      <DiagnosticsSurfaceV2
        coverageAxisLabels={AXIS_LABELS}
        description={DIAGNOSTICS_SURFACE_DESCRIPTION}
        logs={<LogsStandIn />}
        source={source(overrides)}
        title="Diagnostics"
      />
    ),
  };
}

export const Ready = story();

/** The first probe has not come back: a skeleton, and no claim about anything. */
export const Loading = story({
  payload: null,
  refresh: { busy: true, run: () => undefined },
  status: DiagnosticsTransportStatus.Loading,
});

/** The probe failed. The notice carries the host's cleaned message, never a channel name. */
export const ProbeFailed = story({
  errorMessage: "Diagnostics store is locked by another process",
  payload: null,
  status: DiagnosticsTransportStatus.Unavailable,
});

/** A failed refresh over a payload already on screen: the reading stays. */
export const ProbeFailedOverLastReading = story({
  errorMessage: "Diagnostics store is locked by another process",
  status: DiagnosticsTransportStatus.Unavailable,
});

/**
 * ISS-10004 AC2: Links alone refuses, the rest is untouched — the whole
 * difference between degrading and crashing. The `play` is load-bearing: the
 * surface opens on Repos, so without it this story shows a healthy table and the
 * one piece of UI this ticket adds is invisible to visual review.
 */
export const MalformedSection = {
  ...story({ payload: withoutLinkTotals(HEALTHY_PAYLOAD) }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: "Links" }));
    await expect(canvas.getByText("Links could not be read")).toBeVisible();
  },
};

/**
 * Both local-collector sections on — the widest the strip gets — at phone width,
 * because six `whitespace-nowrap` triggers beside the action row is where this
 * page crowds first.
 */
export const AllSectionsOffered = {
  ...story({
    availableSections: [
      DiagnosticsSectionId.Withheld,
      DiagnosticsSectionId.Coverage,
    ],
    settledSections: [
      DiagnosticsSectionId.Withheld,
      DiagnosticsSectionId.Coverage,
    ],
  }),
  parameters: { viewport: { defaultViewport: "mobile1" } },
};

/**
 * ISS-6758: Coverage selected before a probe that asked for it has settled. A
 * skeleton, never the section's "could not measure" claim — that would report a
 * measurement failure about a load still in progress.
 */
export const OptionalReadPending = {
  ...story({
    availableSections: [DiagnosticsSectionId.Coverage],
    settledSections: [DiagnosticsSectionId.Withheld],
  }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: "Coverage" }));
    await expect(canvas.queryByText("Coverage unavailable")).toBeNull();
  },
};

/**
 * No local log reader and no polling loop — the shape a cloud shell would mount.
 * Neither control is offered, rather than offered and inert.
 */
export const WithoutHostLocalRuntime = {
  render: () => (
    <DiagnosticsSurfaceV2
      coverageAxisLabels={AXIS_LABELS}
      description={DIAGNOSTICS_SURFACE_DESCRIPTION}
      logs={null}
      source={source({ autoRefresh: null })}
      title="Diagnostics"
    />
  ),
};

/**
 * ISS-10006 — the browser host. Not "the probe failed": there is no probe here,
 * because it is a local read over the machine that runs the agents.
 *
 * Every section body says so in its own name, because the alternative renders
 * are all lies on this host — an empty Repos list reads as a measured zero, and
 * a skeleton promises a read that will never arrive. Refresh is gone for the
 * same reason, so nothing on the page offers an action it cannot perform.
 */
export const HostCannotServe = {
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: "Refresh" })).toBeNull();
    await expect(canvas.getByText("Repos is not collected here")).toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Coverage" }));
    await expect(
      canvas.getByText("Coverage is not collected here")
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Gateway Logs" }));
    await expect(
      canvas.getByText("Gateway logs stay on your machine")
    ).toBeVisible();
  },
  render: () => (
    <DiagnosticsSurfaceV2
      coverageAxisLabels={AXIS_LABELS}
      description="What the desktop app collects about the machine that runs your agents."
      // The SIXTH tab, which the web host really ships: it is the only section
      // whose treatment differs, so a five-tab story would show neither it nor
      // the fact that both treatments now read the same way.
      logs={
        <EmptyState
          description="The gateway writes them to disk on the machine that runs your agents. Nothing reaches this browser."
          icon={FileTextIcon}
          size="compact"
          title="Gateway logs stay on your machine"
        />
      }
      source={source({
        autoRefresh: null,
        availableSections: [
          DiagnosticsSectionId.Withheld,
          DiagnosticsSectionId.Coverage,
        ],
        errorMessage:
          "Diagnostics are collected by the desktop app on the machine that runs your agents. This browser has no record of them.",
        payload: null,
        status: DiagnosticsTransportStatus.Unavailable,
        unservableReason: "Only the desktop app on that machine has it.",
      })}
      title="Diagnostics"
    />
  ),
};
