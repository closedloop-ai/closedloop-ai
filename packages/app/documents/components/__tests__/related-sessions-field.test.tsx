/**
 * ISS-7235 — the Related Sessions field on the shared non-Session detail stack.
 *
 * Every negative here is paired with a positive, because an empty Related
 * Sessions list satisfies almost any negative assertion this field can make: a
 * section that rendered nothing at all would pass "no editor", "no other org's
 * session", and "no overflow" simultaneously. The pairing is what turns those
 * into coverage.
 */
import {
  PROVENANCE_RELATIONSHIP_KIND_LABELS,
  ProvenanceRelationshipKind,
} from "@repo/api/src/types/provenance-relationship";
import type { RelatedSessionSummary } from "@repo/api/src/types/related-session";
import { RELATED_SESSIONS_FIELD_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiAdapterProvider } from "../../../shared/api/provider";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "../../../shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../../shared/feature-flags/static-feature-flag-adapter";

const mocks = vi.hoisted(() => ({ useRelatedSessions: vi.fn() }));

// The Comments section is flag-gated by its own long-lived `the-one-flag`
// primitive; passing it through keeps the placement assertion about ORDER
// rather than about that unrelated gate.
vi.mock("@repo/app/shared/feature-flags/feature-flagged", () => ({
  FeatureFlagged: ({ children }: { children: unknown }) => children,
}));

vi.mock("../../hooks/use-related-sessions", () => ({
  useRelatedSessions: mocks.useRelatedSessions,
  relatedSessionKeys: { all: ["related-sessions"], list: (id: string) => [id] },
}));

import {
  RELATED_SESSIONS_EMPTY_MESSAGE,
  RELATED_SESSIONS_SECTION_TITLE,
} from "../../lib/related-sessions-labels";
import {
  DOCUMENT_EDITOR_DETAILS_TEST_ID,
  DocumentEditorDetails,
} from "../document-editor-details";
import {
  RelatedSessionsSection,
  toRelatedSessionsCellItem,
} from "../related-sessions-section";

const ARTIFACT = "artifact-a";
/** The artifact the reader navigates TO, without the stack unmounting. */
const OTHER_ARTIFACT = "artifact-b";
const TIME_OF_DAY = /\d{1,2}:\d{2}\s?(AM|PM)/;
const SECTION_TOGGLE = new RegExp(RELATED_SESSIONS_SECTION_TITLE, "i");
/** The newest fixture row, matched on the label inside its accessible name. */
const NEWEST_TRIGGER_NAME = /Refactor the ingest fold/;
const ADA_CONTRIBUTION = /by Ada Lovelace, Aug 21, 2026/;
const UNKNOWN_OWNER_CONTRIBUTION = /by Unknown owner, Aug 2, 2026/;
const LOADING_MESSAGE = /Loading related sessions/;
const NOW = new Date("2026-08-21T15:00:00.000Z");

const OWNER = {
  id: "user-1",
  firstName: "Ada",
  lastName: "Lovelace",
  avatarUrl: null,
};
const OWNER_WITH_AVATAR = {
  ...OWNER,
  avatarUrl: "https://example.test/ada.png",
};

const NEWEST: RelatedSessionSummary = {
  sessionArtifactId: "session-newest",
  slug: "SES-3",
  name: "Refactor the ingest fold",
  status: "active",
  owner: OWNER,
  kind: ProvenanceRelationshipKind.Contribution,
  contributedAt: "2026-08-21T09:04:00.000Z",
};
const MIDDLE: RelatedSessionSummary = {
  sessionArtifactId: "session-middle",
  slug: "SES-2",
  name: "Review the eligibility query",
  status: "inactive",
  owner: OWNER,
  kind: ProvenanceRelationshipKind.Comment,
  contributedAt: "2026-08-14T18:30:00.000Z",
};
const OLDEST: RelatedSessionSummary = {
  sessionArtifactId: "session-oldest",
  slug: "SES-1",
  name: "Draft the provenance model",
  status: "inactive",
  owner: null,
  kind: ProvenanceRelationshipKind.Contribution,
  contributedAt: "2026-08-02T11:00:00.000Z",
};

function seed(
  result: Partial<{
    data: { items: RelatedSessionSummary[]; total: number };
    isLoading: boolean;
    isError: boolean;
  }> = {}
) {
  mocks.useRelatedSessions.mockReturnValue({
    data: result.data,
    isLoading: result.isLoading ?? false,
    isError: result.isError ?? false,
  });
}

function renderField(ui: ReactElement, enabledFlags: readonly string[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
          <ApiAdapterProvider
            adapter={{ resolveApiOrigin: () => "http://test.invalid" }}
          >
            <FeatureFlagAdapterProvider
              adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
            >
              {children}
            </FeatureFlagAdapterProvider>
          </ApiAdapterProvider>
        </AuthAdapterProvider>
      </QueryClientProvider>
    ),
  });
}

function sectionToggle() {
  return screen.getByRole("button", { name: SECTION_TOGGLE });
}

/** The newest row's disclosure trigger, addressed by its accessible name. */
function newestTrigger() {
  return screen.getByRole("button", { name: NEWEST_TRIGGER_NAME });
}

function expand() {
  fireEvent.click(sectionToggle());
}

/** The shared non-Session detail stack, addressing one artifact. */
function detailStack(documentId: string) {
  return (
    <DocumentEditorDetails documentId={documentId}>
      <div>per-type sections</div>
      <RelatedSessionsSection artifactId={documentId} key={documentId} />
    </DocumentEditorDetails>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  seed({ data: { items: [NEWEST, MIDDLE, OLDEST], total: 3 } });
});

describe("Related Sessions gate (ISS-7235, ISS-4779 closed-by-default)", () => {
  test("renders nothing and issues no read when the flag is off", () => {
    renderField(<RelatedSessionsSection artifactId={ARTIFACT} />, []);

    expect(
      screen.queryByText(RELATED_SESSIONS_SECTION_TITLE)
    ).not.toBeInTheDocument();
    const [, enabled] = mocks.useRelatedSessions.mock.calls[0];
    expect(enabled).toBe(false);
  });

  test("renders the section when the flag is on", () => {
    renderField(<RelatedSessionsSection artifactId={ARTIFACT} />, [
      RELATED_SESSIONS_FIELD_FEATURE_FLAG_KEY,
    ]);

    expect(screen.getByText(RELATED_SESSIONS_SECTION_TITLE)).toBeVisible();
  });

  test("defers the read until the section is opened", () => {
    renderField(<RelatedSessionsSection artifactId={ARTIFACT} />, [
      RELATED_SESSIONS_FIELD_FEATURE_FLAG_KEY,
    ]);
    expect(mocks.useRelatedSessions).toHaveBeenLastCalledWith(ARTIFACT, false);

    expand();

    expect(mocks.useRelatedSessions).toHaveBeenLastCalledWith(ARTIFACT, true);
  });
});

describe("Related Sessions presentation (ISS-7235 AC2, AC3, AC4)", () => {
  beforeEach(() => {
    renderField(<RelatedSessionsSection artifactId={ARTIFACT} now={NOW} />, [
      RELATED_SESSIONS_FIELD_FEATURE_FLAG_KEY,
    ]);
    expand();
  });

  test("orders the pills newest contribution first", () => {
    const rendered = screen
      .getAllByRole("listitem")
      .map((node) => node.textContent ?? "");

    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toContain("Refactor the ingest fold");
    expect(rendered[1]).toContain("Review the eligibility query");
    expect(rendered[2]).toContain("Draft the provenance model");
  });

  test("shows today as a time and earlier contributions as MM/DD", () => {
    const [newest, middle, oldest] = screen.getAllByRole("listitem");

    expect(newest.textContent).toMatch(TIME_OF_DAY);
    expect(middle.textContent).toContain("08/14");
    expect(oldest.textContent).toContain("08/02");
  });

  test("states active and inactive in words, not hue alone", () => {
    expect(screen.getByText("Active")).toBeVisible();
    expect(screen.getAllByText("Inactive").length).toBeGreaterThan(0);
  });

  test("states the relationship visibly, not only on hover", () => {
    // The one fact this field exists to state. A tooltip on a non-focusable
    // span never reaches touch or keyboard readers, so the word must render.
    expect(screen.getAllByText("Contributed").length).toBeGreaterThan(0);
    expect(screen.getByText("Commented")).toBeVisible();
  });

  test("names the owner in the accessible sentence", () => {
    expect(screen.getByText(ADA_CONTRIBUTION)).toBeInTheDocument();
    expect(screen.getByText(UNKNOWN_OWNER_CONTRIBUTION)).toBeInTheDocument();
  });

  test("is read-only — it renders the pills and no editor", () => {
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(
      document.querySelectorAll(
        "input, textarea, [contenteditable], [data-grid-primary-editor]"
      )
    ).toHaveLength(0);
  });
});

/**
 * The owner and the full timestamp are the two facts the row does not print,
 * so the disclosure that carries them has to be operable without a mouse
 * (whitlockk review). The screen-reader path was never the gap — the `sr-only`
 * sentence covered that and is asserted above — so these assert the SIGHTED
 * keyboard and touch path: a real focusable control, in the tab order, that
 * opens on keyboard activation.
 *
 * Asserting the accessible NAME alone would not have caught this: the name was
 * already correct on the non-focusable span that shipped.
 *
 * WCAG 2.1 §2.1.1 (Keyboard).
 */
describe("Related Sessions disclosure reachability", () => {
  beforeEach(() => {
    renderField(<RelatedSessionsSection artifactId={ARTIFACT} now={NOW} />, [
      RELATED_SESSIONS_FIELD_FEATURE_FLAG_KEY,
    ]);
    expand();
  });

  test("gives each row a focusable trigger, not a bare span", () => {
    const trigger = newestTrigger();

    trigger.focus();

    expect(trigger).toHaveFocus();
  });

  test("advertises itself as a disclosure, not a bare control", () => {
    // What tells assistive tech there is something behind this control, and
    // what the read-only story matches on to distinguish a disclosure from an
    // editor.
    expect(newestTrigger()).toHaveAttribute("aria-haspopup", "dialog");
    expect(newestTrigger()).toHaveAttribute("aria-expanded", "false");
  });

  test("puts that trigger in the tab order, right after the section toggle", async () => {
    const user = userEvent.setup();
    sectionToggle().focus();

    await user.tab();

    expect(newestTrigger()).toHaveFocus();
  });

  test("opens the owner and full timestamp on keyboard activation", async () => {
    const user = userEvent.setup();
    newestTrigger().focus();

    await user.keyboard("{Enter}");

    // Scoped to the popover, so the `sr-only` sentence inside the trigger
    // cannot satisfy this: the assertion is that a SIGHTED user got it.
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      ADA_CONTRIBUTION
    );
  });

  test("opens it on tap too, which a tooltip never did", async () => {
    const user = userEvent.setup();

    await user.click(newestTrigger());

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      ADA_CONTRIBUTION
    );
  });
});

describe("Related Sessions honest states (ISS-7235)", () => {
  test("says it is loading rather than claiming there are none", () => {
    seed({ isLoading: true });
    renderField(<RelatedSessionsSection artifactId={ARTIFACT} />, [
      RELATED_SESSIONS_FIELD_FEATURE_FLAG_KEY,
    ]);
    expand();

    expect(screen.getByText(LOADING_MESSAGE)).toBeVisible();
    expect(
      screen.queryByText(RELATED_SESSIONS_EMPTY_MESSAGE)
    ).not.toBeInTheDocument();
  });

  test("says the read failed rather than claiming there are none", () => {
    seed({ isError: true });
    renderField(<RelatedSessionsSection artifactId={ARTIFACT} />, [
      RELATED_SESSIONS_FIELD_FEATURE_FLAG_KEY,
    ]);
    expand();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load related sessions."
    );
    expect(
      screen.queryByText(RELATED_SESSIONS_EMPTY_MESSAGE)
    ).not.toBeInTheDocument();
  });

  test("says there are none only when the read succeeded and was empty", () => {
    seed({ data: { items: [], total: 0 } });
    renderField(<RelatedSessionsSection artifactId={ARTIFACT} />, [
      RELATED_SESSIONS_FIELD_FEATURE_FLAG_KEY,
    ]);
    expand();

    expect(screen.getByText(RELATED_SESSIONS_EMPTY_MESSAGE)).toBeVisible();
  });

  test("reports the sessions the cap hid, not the ones it kept", () => {
    seed({ data: { items: [NEWEST, MIDDLE, OLDEST], total: 11 } });
    renderField(<RelatedSessionsSection artifactId={ARTIFACT} />, [
      RELATED_SESSIONS_FIELD_FEATURE_FLAG_KEY,
    ]);
    expand();

    expect(screen.getByText("+8 more")).toBeVisible();
  });
});

describe("toRelatedSessionsCellItem", () => {
  test("reads the relationship label from the canonical vocabulary", () => {
    // Pinned as a literal, NOT re-indexed from the same map the mapper reads:
    // indexing it would let a wrong label drift on both sides and stay green.
    expect(toRelatedSessionsCellItem(MIDDLE).relationshipLabel).toBe(
      "Commented"
    );
    // ...and the canonical map is still the source, so a mapper that hardcoded
    // its own copy of the word would diverge from it here.
    expect(
      PROVENANCE_RELATIONSHIP_KIND_LABELS[ProvenanceRelationshipKind.Comment]
    ).toBe("Commented");
  });

  test("carries a real avatar URL through, and null when there is none", () => {
    // The branch every other fixture leaves unexercised. Radix renders no
    // <img> in jsdom (the image never loads), so the RENDERED image is covered
    // by the Storybook story, which runs in a real browser; what is falsifiable
    // here is the mapper choosing the URL over null.
    expect(
      toRelatedSessionsCellItem({ ...NEWEST, owner: OWNER_WITH_AVATAR })
        .ownerAvatarUrl
    ).toBe("https://example.test/ada.png");
    expect(toRelatedSessionsCellItem(OLDEST).ownerAvatarUrl).toBeNull();
  });

  test("falls back to the slug, then a placeholder, for an unnamed session", () => {
    expect(toRelatedSessionsCellItem({ ...OLDEST, name: null }).label).toBe(
      "SES-1"
    );
    expect(
      toRelatedSessionsCellItem({ ...OLDEST, name: null, slug: null }).label
    ).toBe("Untitled session");
  });
});

/**
 * Same-component navigation (whitlockk review). The document route swaps which
 * artifact the stack addresses WITHOUT unmounting it, so a section that owns
 * open state and is not keyed by the artifact carries that state to the next
 * one — which is why the fixture has to rerender a second artifactId. A
 * single-artifact fixture cannot express this and would pass either way.
 */
describe("Related Sessions across same-component navigation", () => {
  /**
   * Open the field on the first artifact and hand back the rerender that
   * navigates to the second. Each test asserts its own BEFORE state on the same
   * axis it asserts after, so neither passes against a field that never opened.
   */
  function expandOnFirstArtifact() {
    const { rerender } = renderField(detailStack(ARTIFACT), [
      RELATED_SESSIONS_FIELD_FEATURE_FLAG_KEY,
    ]);
    expand();
    return rerender;
  }

  test("starts the next artifact collapsed", () => {
    const navigate = expandOnFirstArtifact();
    expect(sectionToggle()).toHaveAttribute("aria-expanded", "true");

    navigate(detailStack(OTHER_ARTIFACT));

    expect(sectionToggle()).toHaveAttribute("aria-expanded", "false");
  });

  // Split from the case above deliberately: the two are separate failures and
  // asserting them together lets the first mask the second. This is the half a
  // visual check would miss — `open` also gates the READ, so an unkeyed section
  // does not merely LOOK expanded on the next artifact, it fetches that
  // artifact's provenance the reader never asked to see.
  test("does not read the next artifact's provenance unasked", () => {
    const navigate = expandOnFirstArtifact();
    expect(mocks.useRelatedSessions).toHaveBeenLastCalledWith(ARTIFACT, true);

    navigate(detailStack(OTHER_ARTIFACT));

    expect(mocks.useRelatedSessions).toHaveBeenLastCalledWith(
      OTHER_ARTIFACT,
      false
    );
  });
});

describe("Related Sessions placement", () => {
  test("is no longer duplicated in the Details tab", () => {
    renderField(
      <DocumentEditorDetails documentId={ARTIFACT}>
        <div>per-type sections</div>
      </DocumentEditorDetails>,
      [RELATED_SESSIONS_FIELD_FEATURE_FLAG_KEY]
    );
    expect(
      screen.getByTestId(DOCUMENT_EDITOR_DETAILS_TEST_ID)
    ).toBeInTheDocument();
    expect(screen.getByText("Comments")).toBeVisible();
    expect(
      screen.queryByText(RELATED_SESSIONS_SECTION_TITLE)
    ).not.toBeInTheDocument();
  });
});
