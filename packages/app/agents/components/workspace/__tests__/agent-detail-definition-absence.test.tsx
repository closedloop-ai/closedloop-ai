/**
 * ISS-5500 — the Definition panel must not render one blank for two different
 * facts.
 *
 * The ticket's skill (`skill::c22ccd46…`) is an ORPHAN-ONLY identity: the detail
 * read has invocation rows for it but no inventory/version row, so
 * `buildOrphanOnlyDetail` honestly returns `prompt: null`, `versions: []`,
 * `resolvedState: "unresolved"`. The panel then said "We haven't captured this
 * component's definition yet." — the exact same sentence it showed for a
 * component the org demonstrably CAN read whose body simply did not come
 * through. A reader could not tell "nothing was ever recorded" from "this
 * failed to load", which is the state conflation the logical-QA doctrine exists
 * to catch.
 *
 * These tests drive the real `AgentDetail` production path (data source →
 * detail → `PromptPanel`), not a synthetic prop bundle, and every case asserts
 * BOTH sides of the gate: this ships dark under ISS-4779, so "byte-identical to
 * today with the flag off" is the contract, not a courtesy. The distinguishing
 * cases assert against EACH OTHER's copy too — a test that only checked "some
 * empty state rendered" would pass on the bug it exists to catch.
 *
 * #4632 review reshaped what is pinned here. The panel now carries THREE reasons
 * rather than six (the resolution flavors a reader cannot act on differently are
 * named by the header badge, not restated in the panel body), and — the load-
 * bearing correctness change — "a body was captured" is read from the selected
 * revision's `content`, never from the top-level `prompt`, which on desktop can
 * be a frontmatter `description` for a component whose body was never captured.
 */

import { NORMALIZER_CONTRACT_VERSION } from "@repo/api/src/definition-fingerprint";
import {
  type AgentComponentDetail,
  AgentComponentKind,
  ComponentResolvedState,
  type ComponentVersion,
} from "@repo/api/src/types/agent-component";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY } from "../../../../shared/lib/feature-flags";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import {
  DefinitionAbsenceReason,
  deriveDefinitionAbsence,
} from "../../../lib/definition-absence";
import { makeDetail } from "../agent-component-fixtures";
import { AgentDetail } from "../agent-detail";

// The clause of the canonical `unavailable` description that must never reach a
// panel showing no body (hoisted per Ultracite's useTopLevelRegex).
const PRESERVED_COPY_CLAIM_RE = /last-known-good is preserved/;
// The revision-scoped description FEA-4255 renders beneath a multi-revision
// history, asserted by shape so the test does not re-derive `versionLabel`.
const REVISION_SCOPED_RE = /has no captured definition\./;

// The pre-ISS-5500 copy, asserted verbatim as the flag-OFF contract.
const LEGACY_TITLE = "No definition captured";
const LEGACY_DESCRIPTION =
  "We haven't captured this component's definition yet.";

const NEVER_RECORDED = deriveDefinitionAbsence({
  resolvedState: ComponentResolvedState.Unresolved,
});
const INACCESSIBLE = deriveDefinitionAbsence({
  resolvedState: ComponentResolvedState.Inaccessible,
});
const RESOLVED_NO_BODY = deriveDefinitionAbsence({
  resolvedState: ComponentResolvedState.Resolved,
});
const INDETERMINATE = deriveDefinitionAbsence({ resolvedState: null });
const CAPTURED_EMPTY = deriveDefinitionAbsence(
  { resolvedState: ComponentResolvedState.Resolved },
  true
);

/**
 * A Skill with NO definition body — the shape `buildOrphanOnlyDetail` returns
 * for the ticket's component. `kind` must be a prompt-carrying one or the
 * Definition section does not render at all. Built from the shared
 * `makeDetail` factory per `packages/app/agents/AGENTS.md`, so a change to
 * `AgentComponentDetail`'s shape lands in one place.
 */
function makeBodylessSkill(
  resolvedState: AgentComponentDetail["resolvedState"],
  overrides: Partial<AgentComponentDetail> = {}
): AgentComponentDetail {
  return makeDetail({
    id: "skill::c22ccd46",
    slug: "skill::c22ccd46",
    name: "",
    kind: AgentComponentKind.Skill,
    source: "",
    invocations: 2,
    sessions: 1,
    properties: { path: "", format: "md" },
    prompt: null,
    versions: [],
    resolvedState,
    ...overrides,
  });
}

/** A revision carrying a captured body (blank included) under a given contract. */
function revision(
  overrides: Partial<ComponentVersion> & { content: string }
): ComponentVersion {
  return {
    hash: "aaaaaaa0000",
    definitionHash: "def-hash-current",
    normalizerContractVersion: NORMALIZER_CONTRACT_VERSION,
    source: "",
    format: "md",
    createdAt: "2026-06-01T00:00:00.000Z",
    isCurrent: true,
    ...overrides,
  };
}

function testDetailSource(
  detail: AgentComponentDetail
): AgentComponentsDataSource {
  return {
    scope: "test-definition-absence",
    list: () => Promise.reject(new Error("list unused in absence tests")),
    detail: () => Promise.resolve(detail),
  };
}

function Wrapper({
  children,
  dataSource,
  flagOn,
}: {
  children: ReactNode;
  dataSource: AgentComponentsDataSource;
  flagOn: boolean;
}) {
  return (
    <AppCoreStoryProviders
      enabledFlags={
        flagOn ? [AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY] : []
      }
    >
      <AgentComponentsDataSourceProvider dataSource={dataSource}>
        {children}
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

function renderDetail(detail: AgentComponentDetail, flagOn: boolean) {
  render(
    <Wrapper dataSource={testDetailSource(detail)} flagOn={flagOn}>
      <AgentDetail backHref="/acme/agents" slug={detail.id} />
    </Wrapper>
  );
}

describe("AgentDetail Definition panel — absence reason (ISS-5500)", () => {
  it("says nothing was ever recorded for the ticket's orphan-only unresolved skill", async () => {
    renderDetail(makeBodylessSkill(ComponentResolvedState.Unresolved), true);

    expect(await screen.findByText(NEVER_RECORDED.title)).toBeInTheDocument();
    expect(screen.getByText(NEVER_RECORDED.description)).toBeInTheDocument();
    // The failure story must NOT be told about a component that has none.
    expect(screen.queryByText(INACCESSIBLE.title)).not.toBeInTheDocument();
    expect(screen.queryByText(LEGACY_DESCRIPTION)).not.toBeInTheDocument();
  });

  it("says the definition could not be loaded for an inaccessible component", async () => {
    renderDetail(makeBodylessSkill(ComponentResolvedState.Inaccessible), true);

    expect(await screen.findByText(INACCESSIBLE.title)).toBeInTheDocument();
    expect(screen.getByText(INACCESSIBLE.description)).toBeInTheDocument();
    // Distinct from the never-recorded case — this is the whole point.
    expect(screen.queryByText(NEVER_RECORDED.title)).not.toBeInTheDocument();
    expect(
      screen.queryByText(NEVER_RECORDED.description)
    ).not.toBeInTheDocument();
  });

  it("does not claim a body was never recorded when the org says it holds one", async () => {
    // `resolved` means the org can read an exact definition. An absent body here
    // is a failure to load, and calling it "never recorded" would be a lie.
    renderDetail(makeBodylessSkill(ComponentResolvedState.Resolved), true);

    expect(await screen.findByText(RESOLVED_NO_BODY.title)).toBeInTheDocument();
    expect(screen.getByText(RESOLVED_NO_BODY.description)).toBeInTheDocument();
    expect(screen.queryByText(NEVER_RECORDED.title)).not.toBeInTheDocument();
  });

  it("calls a captured-but-blank revision empty, not a load failure", async () => {
    // The collector mints `resolved` whenever it READ the file, including a
    // 0-byte one. Telling that component its body "did not come through" is a
    // specific, confident lie whose suggested remedy can never change anything.
    renderDetail(
      makeBodylessSkill(ComponentResolvedState.Resolved, {
        versions: [revision({ content: "" })],
      }),
      true
    );

    expect(await screen.findByText(CAPTURED_EMPTY.title)).toBeInTheDocument();
    expect(screen.getByText(CAPTURED_EMPTY.description)).toBeInTheDocument();
    expect(screen.queryByText(RESOLVED_NO_BODY.title)).not.toBeInTheDocument();
    expect(screen.queryByText(NEVER_RECORDED.title)).not.toBeInTheDocument();
  });

  it("does not treat a bare empty `prompt` with no revision as a captured body", async () => {
    // #4632 review: the desktop read falls back to the frontmatter `description`
    // when `content` is null, so an empty top-level `prompt` is NOT evidence that
    // a body was captured. Only `ComponentVersion.content` (NOT NULL) is.
    renderDetail(
      makeBodylessSkill(ComponentResolvedState.Resolved, {
        prompt: "",
        versions: [],
      }),
      true
    );

    expect(await screen.findByText(RESOLVED_NO_BODY.title)).toBeInTheDocument();
    expect(screen.queryByText(CAPTURED_EMPTY.title)).not.toBeInTheDocument();
    expect(
      screen.queryByText(CAPTURED_EMPTY.description)
    ).not.toBeInTheDocument();
  });

  it("keeps the badge's story when a blank revision sits under an inaccessible state", async () => {
    // #4632 review: the captured-empty carve-out must not outrank a state in
    // which the org is telling us it could NOT read the definition. Otherwise the
    // header badge reads "could not be read; last-known-good is preserved" while
    // the panel directly beneath reads "captured and contains no text" — one
    // component, one screen, two incompatible claims.
    renderDetail(
      makeBodylessSkill(ComponentResolvedState.Inaccessible, {
        versions: [revision({ content: "" })],
      }),
      true
    );

    expect(await screen.findByText(INACCESSIBLE.title)).toBeInTheDocument();
    expect(screen.queryByText(CAPTURED_EMPTY.title)).not.toBeInTheDocument();
  });

  it("keeps the badge's story when a blank revision sits under a missing state", async () => {
    renderDetail(
      makeBodylessSkill(ComponentResolvedState.Missing, {
        versions: [revision({ content: "" })],
      }),
      true
    );

    expect(await screen.findByText(INACCESSIBLE.title)).toBeInTheDocument();
    expect(screen.queryByText(CAPTURED_EMPTY.title)).not.toBeInTheDocument();
  });

  it("titles a multi-revision blank from the same model as a single-revision one", async () => {
    // #4632 review: `revisionScoped` is `versions.length > 1`, so keeping the
    // legacy title on that path made ONE blank body read "Definition is empty" at
    // one revision and "No definition captured" at two. The description stays
    // revision-scoped (FEA-4255); the headline does not depend on how many
    // revisions the identity happens to carry.
    renderDetail(
      makeBodylessSkill(ComponentResolvedState.Resolved, {
        versions: [
          revision({ content: "" }),
          revision({
            content: "older body",
            createdAt: "2026-05-01T00:00:00.000Z",
            hash: "bbbbbbb1111",
            isCurrent: false,
          }),
        ],
      }),
      true
    );

    expect(await screen.findByText(CAPTURED_EMPTY.title)).toBeInTheDocument();
    expect(screen.getByText(REVISION_SCOPED_RE)).toBeInTheDocument();
    expect(screen.queryByText(LEGACY_TITLE)).not.toBeInTheDocument();
  });

  it("never promises a preserved copy on a panel showing none", async () => {
    // The canonical `unavailable` sentence ends "last-known-good is preserved".
    // This empty state renders precisely because nothing reached the screen, so
    // repeating that clause here would contradict the blank panel beside it.
    renderDetail(makeBodylessSkill(ComponentResolvedState.Inaccessible), true);

    expect(await screen.findByText(INACCESSIBLE.title)).toBeInTheDocument();
    expect(INACCESSIBLE.description).not.toContain("last-known-good");
    expect(screen.queryByText(PRESERVED_COPY_CLAIM_RE)).not.toBeInTheDocument();
  });

  it("keeps the single legacy line for EVERY reason with the flag off", async () => {
    renderDetail(makeBodylessSkill(ComponentResolvedState.Unresolved), false);

    expect(await screen.findByText(LEGACY_TITLE)).toBeInTheDocument();
    expect(screen.getByText(LEGACY_DESCRIPTION)).toBeInTheDocument();
    expect(screen.queryByText(NEVER_RECORDED.title)).not.toBeInTheDocument();
  });

  it("keeps the legacy line with the flag off even for a resolved component", async () => {
    // The flag-off contract is "no change at all", including for the case whose
    // copy changes most.
    renderDetail(makeBodylessSkill(ComponentResolvedState.Resolved), false);

    expect(await screen.findByText(LEGACY_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(RESOLVED_NO_BODY.title)).not.toBeInTheDocument();
  });

  it("keeps the legacy title on a multi-revision blank with the flag off", async () => {
    renderDetail(
      makeBodylessSkill(ComponentResolvedState.Resolved, {
        versions: [
          revision({ content: "" }),
          revision({
            content: "older body",
            createdAt: "2026-05-01T00:00:00.000Z",
            hash: "bbbbbbb1111",
            isCurrent: false,
          }),
        ],
      }),
      false
    );

    expect(await screen.findByText(LEGACY_TITLE)).toBeInTheDocument();
    expect(screen.getByText(REVISION_SCOPED_RE)).toBeInTheDocument();
    expect(screen.queryByText(CAPTURED_EMPTY.title)).not.toBeInTheDocument();
  });
});

/**
 * `AgentComponentDetail.resolvedState` is non-nullable in-process, so an
 * unknown/absent value cannot be constructed through the component without a
 * cast — the same reason `ResolutionBadge`'s malformed path is covered in the
 * model-owned `component-resolution.test.ts` rather than in
 * `agent-detail-resolution.test.tsx`. The loose wire shape a version-skewed peer
 * can actually send is therefore asserted here, against the helper, whose input
 * type genuinely admits it.
 */
describe("deriveDefinitionAbsence", () => {
  it("separates the reasons a reader can act on differently", () => {
    expect(NEVER_RECORDED.reason).toBe(DefinitionAbsenceReason.NeverRecorded);
    expect(INACCESSIBLE.reason).toBe(DefinitionAbsenceReason.Unavailable);
    expect(RESOLVED_NO_BODY.reason).toBe(DefinitionAbsenceReason.Unavailable);
    expect(CAPTURED_EMPTY.reason).toBe(DefinitionAbsenceReason.CapturedEmpty);
  });

  it("reports an unrecognized wire state as unavailable, never as never-recorded", () => {
    // A version-skewed peer's unknown `resolvedState` must not be coerced into
    // the one claim this panel exists to keep apart from a load failure.
    expect(INDETERMINATE.reason).toBe(DefinitionAbsenceReason.Unavailable);
    expect(INDETERMINATE.title).not.toBe(NEVER_RECORDED.title);
  });

  it("scopes the captured-empty carve-out to the resolved family", () => {
    // #4632 review: a blank captured body is a fact about the BODY, but only in
    // the states where the org says it could actually read the definition. Under
    // `inaccessible`/`missing` the resolution state wins, or the badge and the
    // panel make incompatible claims about one component.
    for (const state of [
      ComponentResolvedState.Inaccessible,
      ComponentResolvedState.Missing,
      ComponentResolvedState.Unresolved,
    ]) {
      expect(
        deriveDefinitionAbsence({ resolvedState: state }, true).reason
      ).not.toBe(DefinitionAbsenceReason.CapturedEmpty);
    }
    expect(
      deriveDefinitionAbsence(
        { resolvedState: ComponentResolvedState.Resolved },
        true
      ).reason
    ).toBe(DefinitionAbsenceReason.CapturedEmpty);
  });

  it("treats a fingerprint refinement as part of the resolved family", () => {
    // `contract-mismatch` and `stale-definition` REFINE `resolved` — the org
    // still holds a readable definition — so a blank captured body under either
    // is still a true-zero definition, not a failure.
    expect(
      deriveDefinitionAbsence(
        {
          normalizerContractVersion: NORMALIZER_CONTRACT_VERSION + 1,
          resolvedState: ComponentResolvedState.Resolved,
        },
        true
      ).reason
    ).toBe(DefinitionAbsenceReason.CapturedEmpty);
  });

  it("gives `missing` the same unavailable story as `inaccessible` without collapsing either into never-recorded", () => {
    const missing = deriveDefinitionAbsence({
      resolvedState: ComponentResolvedState.Missing,
    });
    expect(missing.reason).toBe(DefinitionAbsenceReason.Unavailable);
    expect(missing.title).not.toBe(NEVER_RECORDED.title);
  });

  it("renders every reason with copy no other reason produces", () => {
    const copies = [NEVER_RECORDED, INACCESSIBLE, CAPTURED_EMPTY].map(
      (c) => `${c.title}|${c.description}`
    );
    expect(new Set(copies).size).toBe(copies.length);
  });

  it("keeps em dashes out of customer-facing panel copy", () => {
    // House rule: the canonical badge sentences carry em dashes; the panel body
    // is the loudest text in an empty state and does not.
    for (const copy of [NEVER_RECORDED, INACCESSIBLE, CAPTURED_EMPTY]) {
      expect(copy.title).not.toContain("—");
      expect(copy.description).not.toContain("—");
    }
  });

  it("does not instruct the reader to refresh", () => {
    // #4632 review: `EmptyState`'s `action` slot is empty here, so an instruction
    // to retry points at an affordance the panel does not offer.
    for (const copy of [NEVER_RECORDED, INACCESSIBLE, CAPTURED_EMPTY]) {
      expect(copy.description.toLowerCase()).not.toContain("refresh");
    }
  });
});
