import { SessionEvidenceCoverage } from "@repo/api/src/types/session-evidence-coverage-constants";
import { SESSION_TRACE_EVIDENCE_DISCLOSURE_FLAG_KEY } from "@repo/api/src/types/session-trace-evidence-disclosure-flag";
import { TRACE_EVENTS_TRUNCATED_NOTE } from "@repo/app/shared/lib/trace-truncation-copy";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import {
  getTraceCountLabel,
  TRACE_COUNT_METADATA_ONLY_NOTE,
} from "../session-trace-header";
import { withProviders } from "./agent-session-detail-view.test-helpers";

/**
 * ISS-7427 part 3: the reported defect is that "216 trace events" sat as a
 * heading above a panel saying "Transcript not archived" that rendered zero
 * rows. Both statements were true and they described DIFFERENT POPULATIONS —
 * the count is the synced turn-item projection, the panel is the parsed
 * transcript — with nothing on screen saying so.
 *
 * The audit (#5584) established the numbers are neither fabricated nor
 * transcript-derived, so this is a DISCLOSURE contract, not an arithmetic one.
 * These specs pin which coverage states may carry the disclosure, and — the
 * point of the ticket — which states must NOT, because the three that look
 * alike on screen (unavailable, still-arriving, and a true zero) are exactly
 * what the fold exists to keep apart.
 *
 * The pure-formatter specs pin the rule; the last one mounts the COMPOSED view
 * so removing the argument at the production call site cannot leave this file
 * green.
 */

const TRACE_COUNT_SELECTOR = ".sd3-tracehead .sd3-th-count";

function labelFor(
  coverage: SessionEvidenceCoverage | undefined,
  options?: { discloseEvidence?: boolean; eventsTruncated?: boolean }
): string {
  return getTraceCountLabel(
    createAgentSessionDetailFixture({
      ...(coverage === undefined ? {} : { evidenceCoverage: coverage }),
      ...(options?.eventsTruncated === true ? { eventsTruncated: true } : {}),
    }),
    { discloseEvidence: options?.discloseEvidence }
  );
}

describe("session trace evidence disclosure (ISS-7427)", () => {
  it("discloses which population it counted when the main transcript is terminally absent", () => {
    expect(
      labelFor(SessionEvidenceCoverage.MetadataOnly, { discloseEvidence: true })
    ).toContain(TRACE_COUNT_METADATA_ONLY_NOTE);
  });

  // The closed-by-default half of ISS-4779. Its positive sibling is the spec
  // above: without one of the two, "never discloses at all" would satisfy this.
  it("stays byte-identical to the un-disclosed caption while the flag is off", () => {
    const session = createAgentSessionDetailFixture({
      evidenceCoverage: SessionEvidenceCoverage.MetadataOnly,
    });
    expect(getTraceCountLabel(session, { discloseEvidence: false })).toBe(
      getTraceCountLabel(session)
    );
    expect(
      getTraceCountLabel(session, { discloseEvidence: false })
    ).not.toContain(TRACE_COUNT_METADATA_ONLY_NOTE);
  });

  /*
   * The distinction the ticket is actually about. A readable main transcript
   * that genuinely produced no rows is a MEASURED ZERO — telling that reader the
   * count came from somewhere other than the transcript would be the same class
   * of lie pointed the other way. Asserting the count still reads "0 events"
   * alongside the absent note stops a fix that suppresses the number instead of
   * labelling it.
   */
  it("leaves a true zero on a readable transcript unqualified", () => {
    const label = getTraceCountLabel(
      createAgentSessionDetailFixture({
        evidenceCoverage: SessionEvidenceCoverage.MainReadable,
        turnItems: [],
        events: [],
      }),
      { discloseEvidence: true }
    );

    expect(label).toBe("0 events");
    expect(label).not.toContain(TRACE_COUNT_METADATA_ONLY_NOTE);
  });

  /*
   * "Never coming" and "not yet arrived" are different claims and must not be
   * conflated (ISS-7516: a `metadata`-tier device sits in `pending` permanently
   * BY CONSENT). Disclosing over `pending` would tell a user whose upload is
   * simply in flight that their transcript is not the source — which is false
   * the moment it lands.
   */
  it("says nothing while the transcript is still pending", () => {
    expect(
      labelFor(SessionEvidenceCoverage.Pending, { discloseEvidence: true })
    ).not.toContain(TRACE_COUNT_METADATA_ONLY_NOTE);
  });

  /*
   * Guards the predicate against being widened from "is metadataOnly" to "is not
   * mainReadable".
   *
   * UNREACHABLE from `findSessionDetail` today — `SessionDetail.sessionStartedAt`
   * is non-null, so `hasSessionSpan` is always true and a terminal absence lands
   * on `metadataOnly` instead. That is the only reason silence is honest here: in
   * this state the header would still print an unqualified "0 events", and the
   * fold's own contract says that zero is NOT a measured total. If the span ever
   * becomes nullable, or a caller with no span starts using the caller-agnostic
   * fold, this spec must be revisited rather than treated as a settled decision —
   * it would then be pinning a bare zero the fold explicitly forbids reading as
   * measured.
   */
  it("says nothing when no evidence survives at all", () => {
    expect(
      labelFor(SessionEvidenceCoverage.NoEvidence, { discloseEvidence: true })
    ).not.toContain(TRACE_COUNT_METADATA_ONLY_NOTE);
  });

  /*
   * Version skew: an older `apps/api` omits `evidenceCoverage` entirely. Absent
   * must mean "this server does not classify", never a verdict — a client that
   * defaulted it to `metadataOnly` would stamp the note over every session on a
   * lagging deploy, and one that defaulted to `mainReadable` would silently
   * disable the feature while reporting it on.
   */
  it("says nothing when the server sent no classification", () => {
    expect(labelFor(undefined, { discloseEvidence: true })).not.toContain(
      TRACE_COUNT_METADATA_ONLY_NOTE
    );
  });

  /*
   * The two qualifiers are orthogonal — truncation is whether the count is
   * COMPLETE, evidence is WHICH set it counted — so a session can owe both.
   * Pinned as the whole string rather than two `toContain`s: a change that
   * replaced one note with the other would satisfy a pair of containment
   * assertions.
   */
  it("composes with the truncation note instead of replacing it", () => {
    const session = createAgentSessionDetailFixture({
      evidenceCoverage: SessionEvidenceCoverage.MetadataOnly,
      eventsTruncated: true,
    });
    const rows = session.turnItems?.length ?? 0;

    expect(getTraceCountLabel(session, { discloseEvidence: true })).toBe(
      `${rows.toLocaleString()} events · ${TRACE_EVENTS_TRUNCATED_NOTE} · ${TRACE_COUNT_METADATA_ONLY_NOTE}`
    );
  });

  /*
   * Production wiring. The specs above all call the formatter directly, so
   * dropping the options argument at the `session-detail-workspace.tsx` call
   * site would leave every one of them green while the reader saw nothing. This
   * mounts the composed view with the flag actually enabled and reads the
   * rendered heading.
   */
  it("renders the disclosure in the trace heading on the composed view", () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={createAgentSessionDetailFixture({
            evidenceCoverage: SessionEvidenceCoverage.MetadataOnly,
          })}
        />,
        [SESSION_TRACE_EVIDENCE_DISCLOSURE_FLAG_KEY]
      )
    );

    expect(
      document.querySelector<HTMLElement>(TRACE_COUNT_SELECTOR)
    ).toHaveTextContent(TRACE_COUNT_METADATA_ONLY_NOTE);
  });

  // The same mount with no flag enabled: proves the composed view is gated, not
  // merely that the formatter is.
  it("renders no disclosure on the composed view while the flag is off", () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={createAgentSessionDetailFixture({
            evidenceCoverage: SessionEvidenceCoverage.MetadataOnly,
          })}
        />
      )
    );

    expect(
      document.querySelector<HTMLElement>(TRACE_COUNT_SELECTOR)
    ).not.toHaveTextContent(TRACE_COUNT_METADATA_ONLY_NOTE);
  });
});
