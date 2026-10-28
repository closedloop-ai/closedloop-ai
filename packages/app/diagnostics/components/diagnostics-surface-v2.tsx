"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { MonitorOffIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import {
  readBackfillSection,
  readCoverageSection,
  readLinksSection,
  readReposSection,
  readWithheldSection,
} from "../lib/diagnostics-payload-guard";
import {
  DEFAULT_DIAGNOSTICS_SECTION_ID,
  DIAGNOSTICS_OPTIONAL_READ_SECTION_IDS,
  DIAGNOSTICS_SECTIONS,
  DiagnosticsSectionId,
  visibleDiagnosticsSections,
} from "../lib/diagnostics-sections";
import {
  type DiagnosticsSource,
  DiagnosticsTransportStatus,
} from "../lib/diagnostics-source";
import { BackfillSection } from "./backfill-section";
import { CoverageSection } from "./coverage-section";
import type { DiagnosticsSurfaceV2Props } from "./diagnostics-surface-v2-props";
import { LinksSection } from "./links-section";
import { ReposSection } from "./repos-section";
import { WithheldSection } from "./withheld-section";

/**
 * Master Diagnostics, complete (ISS-10004, PRD-730 `wave-fs-3-desktop-to-web`).
 *
 * Owns the navigation, the section layout, the loading / unavailable / malformed
 * state ladder and the feedback on its own actions. A host owns the PROBE and
 * the log reader behind it: on desktop those are privileged main-process IPC
 * calls over this machine's local store and log files, which is exactly the
 * OS/local-runtime bridge PRD-730 leaves with the shell.
 *
 * FEA-976 (`BACKLOG`) owns unifying system check, diagnostics and repair across
 * the two shells. Nothing here anticipates it: the surface runs no check of its
 * own and adds no probe, so the app's single `SystemCheckBootstrap` path stays
 * the only thing that inspects the device. What this surface re-runs is the
 * host's existing read, through the host.
 *
 * Closed by default behind ONE PostHog key
 * (`DIAGNOSTICS_COMPLETE_SURFACE_FEATURE_FLAG_KEY`), read once at each host's
 * mount site. This surface does not know that gate exists.
 */
export function DiagnosticsSurfaceV2({
  coverageAxisLabels,
  description,
  logs,
  source,
  title,
}: DiagnosticsSurfaceV2Props) {
  const [sectionId, setSectionId] = useState<string>(
    DEFAULT_DIAGNOSTICS_SECTION_ID
  );
  const { onSectionChange } = source;
  const handleSectionChange = useCallback(
    (next: string) => {
      setSectionId(next);
      onSectionChange(next as DiagnosticsSectionId);
    },
    [onSectionChange]
  );

  // The Logs section is offered iff its body was supplied. Read from the node
  // rather than from `availableSections` so a host cannot list the tab and hand
  // over nothing to put under it.
  const availableSectionIds: DiagnosticsSectionId[] =
    source.availableSections.filter((id) => id !== DiagnosticsSectionId.Logs);
  if (logs !== null) {
    availableSectionIds.push(DiagnosticsSectionId.Logs);
  }
  const sections = visibleDiagnosticsSections(availableSectionIds);

  return (
    <div
      className="flex w-full flex-col gap-6"
      data-testid={DIAGNOSTICS_SURFACE_V2_TEST_ID}
    >
      <section className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-semibold text-[1.75rem] text-[var(--foreground)] tracking-tight">
            {title}
          </h1>
          <p className="text-[var(--muted-foreground)] text-sm">
            {description}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {source.autoRefresh === null ? null : (
            <Button
              onClick={source.autoRefresh.toggle}
              size="sm"
              variant="outline"
            >
              {source.autoRefresh.enabled ? "Pause" : "Resume"}
            </Button>
          )}
          {/* Nothing to re-run on a host with no probe, so the control is not
              offered at all rather than offered and inert (ISS-10006). */}
          {source.unservableReason === null ? (
            <Button
              disabled={source.refresh.busy}
              onClick={source.refresh.run}
              size="sm"
              variant="outline"
            >
              {DIAGNOSTICS_REFRESH_LABEL}
            </Button>
          ) : null}
        </div>
      </section>

      {source.status === DiagnosticsTransportStatus.Unavailable &&
      source.errorMessage !== null ? (
        <Alert
          data-testid={DIAGNOSTICS_SURFACE_V2_UNAVAILABLE_TEST_ID}
          // ISS-10006 (parkerbowen review). `error` is the destructive tint, and
          // on a host that simply never had a probe it makes the loudest thing
          // on the page a red box saying nothing is wrong — the same "retry
          // forever" invitation `unservableReason` exists to stop. A read that
          // FAILED keeps the red; a host that has no read gets `info`.
          variant={source.unservableReason === null ? "error" : "info"}
        >
          <AlertDescription>{source.errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      <Tabs onValueChange={handleSectionChange} value={sectionId}>
        <TabsList>
          {sections.map((section) => (
            <TabsTrigger key={section.id} value={section.id}>
              {section.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {sections.map((section) => (
          <TabsContent key={section.id} value={section.id}>
            {sectionBody({
              coverageAxisLabels,
              logs,
              sectionId: section.id,
              source,
            })}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function DiagnosticsSkeleton() {
  return (
    <div
      className="space-y-4"
      data-testid={DIAGNOSTICS_SURFACE_V2_LOADING_TEST_ID}
    >
      <Skeleton className="h-[200px] w-full" />
      <Skeleton className="h-[150px] w-full" />
    </div>
  );
}

/**
 * The one render a malformed field is allowed to produce, and it is deliberately
 * NOT the transport's failure notice: "the producer sent something this build
 * cannot read" and "the read never came back" are different faults with
 * different next steps, and a reader on a diagnostics page is the one person who
 * needs to be told which.
 */
function MalformedSection({ label }: { label: string }) {
  const titleId = `${DIAGNOSTICS_SURFACE_V2_MALFORMED_TEST_ID}-${label.toLowerCase()}`;
  return (
    <Alert
      aria-labelledby={titleId}
      data-testid={DIAGNOSTICS_SURFACE_V2_MALFORMED_TEST_ID}
      variant="warning"
    >
      <AlertTitle id={titleId}>{label} could not be read</AlertTitle>
      <AlertDescription>
        This build received {label} data it cannot interpret, so nothing is
        shown for it. The other sections are unaffected.
      </AlertDescription>
    </Alert>
  );
}

/**
 * ISS-10006 — the render a section gets on a host that can never serve it.
 *
 * Its own locator, and deliberately not `MalformedSection`'s or the transport
 * notice's: "this host has no probe" is a different fact from "the producer sent
 * something unreadable" and from "the read failed", and only the first one has
 * no next step the reader can take here. Naming the SECTION in the title is what
 * makes it an explicit absence rather than the route notice repeated six times.
 *
 * An EMPTY STATE rather than an `Alert`, for two reasons (parkerbowen review).
 * `Alert` carries `role="alert"`, an assertive live region, and Radix mounts
 * only the active `TabsContent` — so every tab switch would interrupt a screen
 * reader to announce content the reader just asked for. And a host supplying the
 * same fact for Gateway Logs already supplies an `EmptyState`, so an alert here
 * would render one fact in two visual languages, one click apart.
 */
function UnservableSection({
  label,
  reason,
}: {
  label: string;
  reason: string;
}) {
  return (
    <div data-testid={DIAGNOSTICS_SURFACE_V2_UNSERVABLE_TEST_ID}>
      <EmptyState
        description={reason}
        icon={MonitorOffIcon}
        size="compact"
        title={`${label} is not collected here`}
        titleAs="h2"
      />
    </div>
  );
}

function diagnosticsSectionLabel(sectionId: DiagnosticsSectionId): string {
  return (
    DIAGNOSTICS_SECTIONS.find((section) => section.id === sectionId)?.label ??
    sectionId
  );
}

function sectionBody({
  coverageAxisLabels,
  logs,
  sectionId,
  source,
}: {
  coverageAxisLabels: DiagnosticsSurfaceV2Props["coverageAxisLabels"];
  logs: ReactNode | null;
  sectionId: DiagnosticsSectionId;
  source: DiagnosticsSource;
}): ReactNode {
  // The host's log reader does its own loading and failure reporting against a
  // source the probe never touches, so it renders whatever the probe is doing.
  if (sectionId === DiagnosticsSectionId.Logs) {
    return logs;
  }
  // ISS-10006. Before every other branch, because on a host with no probe the
  // others describe a read that is not happening: a skeleton promises one in
  // flight, `null` renders an empty section that reads as a measured zero, and
  // the transport notice reads as a failure worth retrying.
  if (source.unservableReason !== null) {
    return (
      <UnservableSection
        label={diagnosticsSectionLabel(sectionId)}
        reason={source.unservableReason}
      />
    );
  }
  const { payload } = source;
  if (payload === null) {
    return source.status === DiagnosticsTransportStatus.Loading ? (
      <DiagnosticsSkeleton />
    ) : null;
  }
  // ISS-6758: selecting an optional section is what asks for its read, so until
  // a probe that ASKED has settled, the payload in hand was fetched without it.
  // Its absence would render as "could not measure" — a false failure claim
  // about a load still in progress.
  if (
    DIAGNOSTICS_OPTIONAL_READ_SECTION_IDS.includes(sectionId) &&
    !source.settledSections.includes(sectionId)
  ) {
    return <DiagnosticsSkeleton />;
  }

  switch (sectionId) {
    case DiagnosticsSectionId.Repos: {
      const repos = readReposSection(payload);
      return repos === null ? (
        <MalformedSection label="Repos" />
      ) : (
        <ReposSection repos={repos} />
      );
    }
    case DiagnosticsSectionId.Backfill: {
      const backfill = readBackfillSection(payload);
      return backfill === null ? (
        <MalformedSection label="Backfill" />
      ) : (
        <BackfillSection backfill={backfill} />
      );
    }
    case DiagnosticsSectionId.Links: {
      const links = readLinksSection(payload);
      return links === null ? (
        <MalformedSection label="Links" />
      ) : (
        <LinksSection
          linkStats={links.linkStats}
          linkTotals={links.linkTotals}
        />
      );
    }
    case DiagnosticsSectionId.Withheld: {
      const withheld = readWithheldSection(payload);
      return withheld === null ? (
        <MalformedSection label="Withheld" />
      ) : (
        <WithheldSection scans={withheld.scans} withheld={withheld.withheld} />
      );
    }
    case DiagnosticsSectionId.Coverage: {
      const coverage = readCoverageSection(payload);
      return coverage === null ? (
        <MalformedSection label="Coverage" />
      ) : (
        <CoverageSection
          axisLabels={coverageAxisLabels}
          coverage={coverage.coverage}
        />
      );
    }
    default: {
      // tamsinb review: Coverage used to be the `default` arm, so a SEVENTH
      // member of `DiagnosticsSectionId` compiled and silently rendered the
      // Coverage body under another section's tab. Naming Coverage and
      // assigning the remainder to `never` moves that to a tsc failure on the
      // missing arm.
      const unreachable: never = sectionId;
      return unreachable;
    }
  }
}

/**
 * What this surface reports on a host that runs the probe. Still exported, and
 * still the desktop host's sentence — ISS-10006 made it a host-supplied PROP
 * rather than a constant the surface asserts, because it is only true where the
 * probe runs.
 */
export const DIAGNOSTICS_SURFACE_DESCRIPTION =
  "Gateway health, logs, backfill state and withheld data.";

/**
 * Marks the surface's root so a host's E2E can prove which branch of its gate
 * rendered — the OFF case asserts ABSENCE, and an absence written against copy
 * both branches share would pass on either.
 */
export const DIAGNOSTICS_SURFACE_V2_TEST_ID = "diagnostics-surface-v2";

/**
 * One locator per state that shows no section data. "The table is absent" is
 * satisfied by the skeleton, by the failure notice, by an empty fixture and by
 * an error boundary that swallowed something else entirely; each of these is
 * emitted by exactly one branch.
 */
export const DIAGNOSTICS_SURFACE_V2_UNAVAILABLE_TEST_ID =
  "diagnostics-surface-v2-unavailable";
export const DIAGNOSTICS_SURFACE_V2_MALFORMED_TEST_ID =
  "diagnostics-surface-v2-malformed";
export const DIAGNOSTICS_SURFACE_V2_LOADING_TEST_ID =
  "diagnostics-surface-v2-loading";
/**
 * ISS-10006 — the host-cannot-serve render's own locator. Separate from
 * `…_UNAVAILABLE_TEST_ID` because a spec asserting "no section data is shown"
 * against the transport notice would pass on a browser host that silently showed
 * nothing, which is the state this locator exists to make visible.
 */
export const DIAGNOSTICS_SURFACE_V2_UNSERVABLE_TEST_ID =
  "diagnostics-surface-v2-unservable";

export const DIAGNOSTICS_REFRESH_LABEL = "Refresh";
