import {
  TranscriptAvailability,
  type TranscriptAvailabilitySummary,
} from "@repo/api/src/types/desktop-transcripts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { withTranscriptFileParam } from "../../../lib/session-transcript-href";
import { TranscriptFileSwitcher } from "../transcript-file-switcher";

const SESSION_HREF = "/sessions/session-1";
const DISCLOSURE_NAME = /subagent transcripts/i;
const ANY_SUBAGENT_LINK = /^Subagent /;
const HEADER_COUNT_NINE = /Subagent transcripts \(9\)/;
const HEADER_PAREN_NINE = /\(9\)/;
const CAPTION_COUNT_CLAUSE = /transcripts available/;
const HEADER_TWELVE_AND_NINE = /12 subagents, 9 transcripts available/;
const HEADER_ONE_UPLOADING = /1 still uploading/;
const HEADER_TWO_UPLOADING = /2 still uploading/;
const HEADER_ONE_UNAVAILABLE = /1 unavailable/;
const ANY_DIGIT = /\d/;
const AGENT_NINE_LINK = /Subagent agent-9/;
const HEADER_ANY = /Subagent transcripts/;
// "Archived"/"synced"/"uploaded" all assert the bytes reached a remote
// archive. That is false for a desktop-local session (`uploadedAt: null`), and
// "archived" additionally reads as "moved out of view" — the one thing this
// surface must never imply.
const TRANSPORT_VERB = /archived|synced|uploaded/i;

function file(
  fileKey: string,
  availability: TranscriptAvailability = TranscriptAvailability.Available
): TranscriptAvailabilitySummary {
  return {
    fileKey,
    availability,
    uploadedAt: "2026-08-01T12:00:00.000Z",
    permanentFailureReason: null,
  };
}

function sidechains(count: number): TranscriptAvailabilitySummary[] {
  return Array.from({ length: count }, (_unused, index) =>
    file(`subagent:agent-${index + 1}`)
  );
}

function renderSwitcher({
  activeFileKey = "main",
  files,
  subagentCount,
}: {
  activeFileKey?: string;
  files: TranscriptAvailabilitySummary[] | undefined;
  subagentCount: number | null;
}) {
  return render(
    // ISS-5366 retired `sessions-subagent-transcript-disclosure`, so the
    // disclosure is the switcher's only rendering. The providers stay for the
    // routing adapter the chips' `Link`s need — no flag is seeded.
    <AppCoreStoryProviders>
      <TranscriptFileSwitcher
        activeFileKey={activeFileKey}
        buildHref={(fileKey) => withTranscriptFileParam(SESSION_HREF, fileKey)}
        files={files}
        subagentCount={subagentCount}
      />
    </AppCoreStoryProviders>
  );
}

describe("TranscriptFileSwitcher — collapsed subagent disclosure (ISS-4677)", () => {
  it("hides the sidechain chips behind a collapsed disclosure by default", async () => {
    renderSwitcher({
      files: [file("main"), ...sidechains(9)],
      subagentCount: 9,
    });

    // Main stays inline; the nine sidechain pills do not.
    expect(await screen.findByRole("link", { name: "Main" })).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Subagent agent-4" })
    ).not.toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: DISCLOSURE_NAME });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAccessibleName(HEADER_COUNT_NINE);
  });

  it("reveals every sidechain chip when the disclosure is opened", async () => {
    const user = userEvent.setup();
    renderSwitcher({
      files: [file("main"), ...sidechains(9)],
      subagentCount: 9,
    });

    await user.click(
      await screen.findByRole("button", { name: DISCLOSURE_NAME })
    );

    expect(
      screen.getByRole("button", { name: DISCLOSURE_NAME })
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("link", { name: "Subagent agent-4" })
    ).toHaveAttribute("href", `${SESSION_HREF}?file=subagent%3Aagent-4`);
    expect(
      screen.getAllByRole("link", { name: ANY_SUBAGENT_LINK })
    ).toHaveLength(9);
  });

  it("is operable from the keyboard", async () => {
    const user = userEvent.setup();
    renderSwitcher({
      files: [file("main"), ...sidechains(9)],
      subagentCount: 9,
    });

    const trigger = await screen.findByRole("button", {
      name: DISCLOSURE_NAME,
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("orders the revealed chips numerically, not in producer order", async () => {
    const user = userEvent.setup();
    renderSwitcher({
      files: [
        file("main"),
        file("subagent:agent-10"),
        file("subagent:agent-2"),
        file("subagent:agent-1"),
      ],
      subagentCount: 3,
    });

    await user.click(
      await screen.findByRole("button", { name: DISCLOSURE_NAME })
    );
    expect(
      screen
        .getAllByRole("link", { name: ANY_SUBAGENT_LINK })
        .map((el) => el.textContent)
    ).toEqual(["Subagent agent-1", "Subagent agent-2", "Subagent agent-10"]);
  });

  // Collapsing may hide options; it may never hide WHERE YOU ARE.
  it("pins the deep-linked sidechain inline while collapsed", async () => {
    renderSwitcher({
      activeFileKey: "subagent:agent-4",
      files: [file("main"), ...sidechains(9)],
      subagentCount: 9,
    });

    const active = await screen.findByRole("link", {
      name: "Subagent agent-4",
    });
    expect(active).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("button", { name: DISCLOSURE_NAME })
    ).toHaveAttribute("aria-expanded", "false");
    // Only the pinned one is visible while shut; the other eight stay folded.
    expect(
      screen.getAllByRole("link", { name: ANY_SUBAGENT_LINK })
    ).toHaveLength(1);
  });

  it("keeps the pinned chip anchored on open without announcing it twice", async () => {
    const user = userEvent.setup();
    renderSwitcher({
      activeFileKey: "subagent:agent-4",
      files: [file("main"), ...sidechains(9)],
      subagentCount: 9,
    });

    await user.click(
      await screen.findByRole("button", { name: DISCLOSURE_NAME })
    );
    // Dropping the pin on open shifted the row under the reader mid-interaction.
    // It stays put — but the inline copy is inert, so the accessible tree still
    // offers each sidechain exactly once and only the drawer's copy is current.
    expect(
      screen.getAllByRole("link", { name: ANY_SUBAGENT_LINK })
    ).toHaveLength(9);
    expect(
      screen.getAllByRole("link", { name: "Subagent agent-4" })
    ).toHaveLength(1);
    const inert = document.querySelector('a[aria-hidden="true"]');
    expect(inert).toHaveTextContent("Subagent agent-4");
    expect(inert).toHaveAttribute("tabindex", "-1");
  });

  it("keeps a single sidechain inline instead of folding one chip", async () => {
    renderSwitcher({
      files: [file("main"), ...sidechains(1)],
      subagentCount: 1,
    });

    expect(
      await screen.findByRole("link", { name: "Subagent agent-1" })
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: DISCLOSURE_NAME })
    ).not.toBeInTheDocument();
  });
});

describe("TranscriptFileSwitcher — reconciliation and honest states (ISS-4677)", () => {
  it("reconciles the file count against the Subagents metric on the header", async () => {
    renderSwitcher({
      files: [file("main"), ...sidechains(9)],
      subagentCount: 12,
    });

    const trigger = await screen.findByRole("button", {
      name: DISCLOSURE_NAME,
    });
    expect(trigger).toHaveAccessibleName(HEADER_TWELVE_AND_NINE);
    // The count is stated ONCE: the caption carries both numbers, so the
    // parenthetical is dropped rather than printing "9" twice.
    expect(trigger).not.toHaveAccessibleName(HEADER_PAREN_NINE);
  });

  it("states a bare count when the files and the metric already agree", async () => {
    renderSwitcher({
      files: [file("main"), ...sidechains(9)],
      subagentCount: 9,
    });

    const trigger = await screen.findByRole("button", {
      name: DISCLOSURE_NAME,
    });
    expect(trigger).toHaveAccessibleName(HEADER_COUNT_NINE);
    // The reconciliation clause is absent entirely — not merely reworded — so
    // the bare "(9)" is the only number on the header.
    expect(trigger).not.toHaveAccessibleName(CAPTION_COUNT_CLAUSE);
  });

  // An unknown metric must never become a fabricated shortfall.
  it("claims no shortfall when the Subagents metric is unavailable", async () => {
    renderSwitcher({
      files: [file("main"), ...sidechains(9)],
      subagentCount: null,
    });

    expect(
      await screen.findByRole("button", { name: DISCLOSURE_NAME })
    ).not.toHaveAccessibleName(CAPTION_COUNT_CLAUSE);
  });

  // "Still uploading" is a promise. Only an in-flight upload may borrow it.
  it("words a still-uploading sidechain differently from an unavailable one", async () => {
    renderSwitcher({
      files: [
        file("main"),
        ...sidechains(4),
        file("subagent:agent-5", TranscriptAvailability.UploadPending),
        file("subagent:agent-6", TranscriptAvailability.UploadFailed),
      ],
      subagentCount: 6,
    });

    const trigger = await screen.findByRole("button", {
      name: DISCLOSURE_NAME,
    });
    expect(trigger).toHaveAccessibleName(HEADER_ONE_UPLOADING);
    expect(trigger).toHaveAccessibleName(HEADER_ONE_UNAVAILABLE);
    expect(trigger).not.toHaveAccessibleName(HEADER_TWO_UPLOADING);
  });

  it("renders a permanently unavailable sidechain as a status chip, not a link", async () => {
    const user = userEvent.setup();
    renderSwitcher({
      files: [
        file("main"),
        ...sidechains(2),
        file("subagent:agent-9", TranscriptAvailability.PermanentlyUnavailable),
      ],
      subagentCount: 3,
    });

    await user.click(
      await screen.findByRole("button", { name: DISCLOSURE_NAME })
    );
    // The archive will never hold those bytes, so there is nothing to link to.
    expect(
      screen.queryByRole("link", { name: "Subagent agent-9" })
    ).not.toBeInTheDocument();
    expect(screen.getByText("Subagent agent-9")).toBeVisible();
  });

  it("renders an unreachable chip as a marked non-link, not a dead deep link", async () => {
    const user = userEvent.setup();
    renderSwitcher({
      files: [
        file("main"),
        ...sidechains(2),
        file("subagent:agent-9", TranscriptAvailability.UploadFailed),
      ],
      subagentCount: 3,
    });

    await user.click(
      await screen.findByRole("button", { name: DISCLOSURE_NAME })
    );
    // A failed upload has no bytes to open, so it must not be a hover-lit link
    // promising a transcript, and the reason has to be readable without a hover
    // tooltip a keyboard or touch user never sees.
    expect(
      screen.queryByRole("link", { name: AGENT_NINE_LINK })
    ).not.toBeInTheDocument();
    expect(screen.getByText("Subagent agent-9")).toBeVisible();
    expect(screen.getAllByText("· unavailable")).toHaveLength(1);
    expect(
      screen.getByRole("link", { name: "Subagent agent-1" })
    ).toBeInTheDocument();
  });

  it("marks a still-uploading chip as in flight and keeps it openable", async () => {
    const user = userEvent.setup();
    renderSwitcher({
      files: [
        file("main"),
        ...sidechains(2),
        file("subagent:agent-9", TranscriptAvailability.UploadPending),
      ],
      subagentCount: 3,
    });

    await user.click(
      await screen.findByRole("button", { name: DISCLOSURE_NAME })
    );
    // "Coming" and "never coming" must not flatten into one warning pill: the
    // bytes may land while the panel is open, so the link stays.
    expect(
      screen.getByRole("link", { name: AGENT_NINE_LINK })
    ).toBeInTheDocument();
    expect(screen.getByText("· uploading")).toBeVisible();
  });

  it("states the reconciliation even when the chips are not folded", () => {
    renderSwitcher({
      files: [file("main"), file("subagent:agent-1")],
      subagentCount: 5,
    });
    // One sidechain is below the fold threshold, so the disclosure never mounts
    // — but a Subagents metric of 5 against one readable file is exactly as
    // contradictory here as it is inside the drawer.
    expect(
      screen.queryByRole("button", { name: DISCLOSURE_NAME })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("5 subagents, 1 transcript available")
    ).toBeVisible();
  });

  it("drops the bare count when the files OUTNUMBER the reported subagents", async () => {
    const user = userEvent.setup();
    renderSwitcher({
      files: [file("main"), ...sidechains(9)],
      subagentCount: 3,
    });

    const trigger = await screen.findByRole("button", {
      name: HEADER_ANY,
    });
    expect(trigger).not.toHaveTextContent("Subagent transcripts (9)");
    expect(
      screen.getByText("3 subagents, 9 transcripts available")
    ).toBeVisible();
    await user.click(trigger);
    expect(
      screen.getAllByRole("link", { name: ANY_SUBAGENT_LINK })
    ).toHaveLength(9);
  });

  // The two states the old SessionOverviewSection conflated.
  it("renders nothing — no confident zero — when availability was never reported", () => {
    const { container } = renderSwitcher({
      files: undefined,
      subagentCount: null,
    });
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toMatch(ANY_DIGIT);
  });

  it("renders nothing for a reported zero-sidechain session", () => {
    const { container } = renderSwitcher({
      files: [file("main")],
      subagentCount: 0,
    });
    expect(
      within(container).queryByRole("button", { name: DISCLOSURE_NAME })
    ).not.toBeInTheDocument();
    expect(container.querySelector("a")).toBeNull();
  });
});

/**
 * ISS-5762 — the standing proof that this surface shows the WHOLE subagent
 * population, not a bounded prefix of it.
 *
 * The observed report was a session detail whose disclosure read
 * "122 archived · 72 reported", which looks exactly like a silent cap admitting
 * itself. It is not one: nothing between the `SessionTranscript` rows and these
 * chips bounds the set (the cloud read issues an uncapped
 * `sessionTranscript.findMany`, the desktop's local resolver is likewise
 * uncapped, and the disclosure COLLAPSES the chip wall rather than trimming it).
 * That caption is the ISS-4677 reconciliation between two independent lanes.
 *
 * The fixture is deliberately sized ABOVE every row cap in the tree that could
 * plausibly be reached for and applied here — `AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS`
 * (50), `SUBAGENT_TRANSCRIPT_INLINE_LIMIT` (1), and the 100 that a "round
 * number" cap would most likely use — so a cap introduced at ANY of those
 * values fails here instead of shipping a confident subset. A fixture that fits
 * under the cap is how ISS-5520 and ISS-5521 stayed green while their bug was
 * live.
 */
describe("TranscriptFileSwitcher — no silent subsetting (ISS-5762)", () => {
  const OBSERVED_SIDECHAIN_COUNT = 122;
  const OBSERVED_REPORTED_SUBAGENTS = 72;

  it("renders a chip for every sidechain when the population far exceeds any cap in the tree", async () => {
    const user = userEvent.setup();
    renderSwitcher({
      files: [file("main"), ...sidechains(OBSERVED_SIDECHAIN_COUNT)],
      subagentCount: OBSERVED_REPORTED_SUBAGENTS,
    });

    const trigger = screen.getByRole("button", { name: DISCLOSURE_NAME });
    await user.click(trigger);

    expect(
      screen.getAllByRole("link", { name: ANY_SUBAGENT_LINK })
    ).toHaveLength(OBSERVED_SIDECHAIN_COUNT);
    // Both ends of the population, so a prefix-shaped OR suffix-shaped cap is
    // caught rather than only one of them.
    expect(
      screen.getByRole("link", { name: "Subagent agent-1" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: `Subagent agent-${OBSERVED_SIDECHAIN_COUNT}`,
      })
    ).toBeInTheDocument();
  });

  it("states the reconciliation in words that cannot be read as 'hidden'", () => {
    renderSwitcher({
      files: [file("main"), ...sidechains(OBSERVED_SIDECHAIN_COUNT)],
      subagentCount: OBSERVED_REPORTED_SUBAGENTS,
    });

    expect(
      screen.getByText(
        `${OBSERVED_REPORTED_SUBAGENTS} subagents, ${OBSERVED_SIDECHAIN_COUNT} transcripts available`
      )
    ).toBeVisible();
    // "archived" is this codebase's word for "uploaded to storage", but it reads
    // as "moved out of view" — the one thing this surface must never imply —
    // and every transport verb is a claim the desktop-local lane cannot back.
    expect(screen.queryByText(TRANSPORT_VERB)).not.toBeInTheDocument();
  });
});
