import { DocumentType } from "@repo/api/src/types/document";
import type {
  UserContributionHeatmap,
  UserProfileHeadline,
} from "@repo/api/src/types/user";
import { act, render, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, expect, test, vi } from "vitest";

// Isolate the stats grid: stub the data hooks and the non-stat children
// (header, charts, heatmap) so the test asserts only how the stat tiles render.
// FEA-4064 split the single stats hook into two independent widget queries.
const mockUseUser = vi.fn();
const mockUseUserProfileHeadline = vi.fn();
const mockUseUserContributionHeatmap = vi.fn();
const mockUseUserProfileStanding = vi.fn();
const mockUseUserProfileMilestones = vi.fn();

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useUser: () => mockUseUser(),
  useUserProfileHeadline: () => mockUseUserProfileHeadline(),
  useUserContributionHeatmap: () => mockUseUserContributionHeatmap(),
  useUserProfileStanding: () => mockUseUserProfileStanding(),
  useUserProfileMilestones: () => mockUseUserProfileMilestones(),
}));

// `next/dynamic` loads the ContributionHeatmap. Return a distinct sentinel that
// echoes the point count it was handed, so a test can prove the heatmap (not the
// other chart) rendered under Activity with the expected `data` prop.
vi.mock("next/dynamic", () => ({
  default: () => (props: { data: unknown[] }) => (
    <div data-heatmap-points={props.data.length} data-testid="heatmap" />
  ),
}));

vi.mock("../components/user-profile-header", () => ({
  UserProfileHeader: () => null,
}));

// Distinct sentinel echoing its own point count, so the Activity assertion can
// tell the artifact breakdown apart from the heatmap and confirm its `data`.
vi.mock("../components/documents-by-type-chart", () => ({
  DocumentsByTypeChart: (props: { data: unknown[] }) => (
    <div
      data-doctype-points={props.data.length}
      data-testid="documents-chart"
    />
  ),
}));

vi.mock("../../../../components/header", () => ({
  Header: () => null,
}));

const HEADLINE: UserProfileHeadline = {
  totalDocuments: 12,
  // Two entries — a distinct count from the heatmap so the Activity assertion
  // can prove each chart got its own `data` prop, not a shared/empty array.
  documentsByType: [
    { type: DocumentType.Prd, count: 8 },
    { type: DocumentType.ImplementationPlan, count: 4 },
  ],
  totalComments: 34,
  totalPRsLanded: 5,
  totalLoops: 7,
  avgConcurrency: 2,
  totalTokensInput: 1000,
  totalTokensOutput: 2000,
  totalEstimatedCost: 3.5,
};

const HEATMAP: UserContributionHeatmap = {
  // Three day-cells — distinct from documentsByType's two entries.
  contributionHeatmap: [
    { date: "2026-01-01", count: 1 },
    { date: "2026-01-02", count: 2 },
    { date: "2026-01-03", count: 0 },
  ],
};

/** Default-mock both widget queries to a loaded, successful state. */
function mockLoaded() {
  mockUseUser.mockReturnValue({ data: null, isLoading: false });
  mockUseUserProfileHeadline.mockReturnValue({
    data: HEADLINE,
    isLoading: false,
    isError: false,
  });
  mockUseUserContributionHeatmap.mockReturnValue({
    data: HEATMAP,
    isLoading: false,
    isError: false,
  });
  // FEA-4108: default the standing/milestones widgets to a loaded state with no
  // real data, so both sections stay hidden and the existing Headline/Activity
  // assertions (skeleton counts, landmark counts) are unaffected by default.
  mockUseUserProfileStanding.mockReturnValue({
    data: { streak: null },
    isLoading: false,
    isError: false,
  });
  mockUseUserProfileMilestones.mockReturnValue({
    data: { milestones: [] },
    isLoading: false,
    isError: false,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

async function renderPage() {
  const mod = await import("../page");
  const Page = mod.default as ComponentType<{
    params: Promise<{ orgSlug: string; userId: string }>;
  }>;
  // The page unwraps `params` via `use()`, which suspends on first render.
  // Resolve params first, then flush the suspended tree inside act.
  const params = Promise.resolve({ orgSlug: "acme", userId: "u1" });
  await params;
  let result!: ReturnType<typeof render>;
  await act(() => {
    result = render(<Page params={params} />);
  });
  return result;
}

test("stat tiles render via the DS MetricCard, not a hand-rolled gradient card", async () => {
  mockLoaded();

  const { container } = await renderPage();

  // MetricCard renders the value in a card-title slot and the label in a
  // card-description slot. The old StatTile rendered a bare div/p with none of
  // these slots, so asserting the slots proves the tiles compose MetricCard.
  // Scope to the Headlines section so the Activity Section cards (which also
  // use card-title/description slots) don't inflate the stat-tile count.
  const headlines = container.querySelector(
    'section[aria-labelledby="headline-stats-heading"]'
  ) as HTMLElement;
  const titleSlots = headlines.querySelectorAll('[data-slot="card-title"]');
  const descriptionSlots = headlines.querySelectorAll(
    '[data-slot="card-description"]'
  );

  // Eight stat tiles from the headline grid.
  expect(titleSlots.length).toBe(8);
  expect(descriptionSlots.length).toBe(8);

  const labels = Array.from(descriptionSlots).map((node) =>
    node.textContent?.trim()
  );
  expect(labels).toContain("Artifacts created");
  expect(labels).toContain("Estimated cost");

  // The formatted values land in the MetricCard title slot.
  const values = Array.from(titleSlots).map((node) => node.textContent?.trim());
  expect(values).toContain("12");
  expect(values).toContain("$3.50");

  // The retired hand-rolled tile used an inline linear-gradient background;
  // no tile should carry it anymore.
  const gradientTiles = Array.from(
    container.querySelectorAll<HTMLElement>("[style]")
  ).filter((node) => node.style.background.includes("linear-gradient"));
  expect(gradientTiles.length).toBe(0);
});

test("preserves the one-decimal avg concurrency signal instead of rounding to a whole number", async () => {
  // The API deliberately returns one decimal for avg loop concurrency; rounding
  // 2.4 to 2 with the general number formatter erases the entire signal.
  mockLoaded();
  mockUseUserProfileHeadline.mockReturnValue({
    data: { ...HEADLINE, avgConcurrency: 2.4 },
    isLoading: false,
    isError: false,
  });

  const { container } = await renderPage();

  const values = Array.from(
    container.querySelectorAll('[data-slot="card-title"]')
  ).map((node) => node.textContent?.trim());
  expect(values).toContain("2.4");
  expect(values).not.toContain("2");
});

test("names the headline stats section as an h2 with its active window, and gives ambiguous-label tiles an info affordance", async () => {
  mockLoaded();

  const { container } = await renderPage();

  // The grid opens with a real h2 at parity with the two sections below it,
  // named for what it is, and carries the active window so the numbers are not
  // read as lifetime totals (FEA-4064).
  const heading = container.querySelector("h2#headline-stats-heading");
  expect(heading?.textContent).toContain("Headline metrics");
  expect(heading?.textContent).toContain("Last 30 days");

  // The jargon labels ("Loops Initiated", "Avg Loop Concurrency", "Estimated
  // Cost") each get an accessible info-popover trigger.
  const infoTriggers = container.querySelectorAll(
    'button[aria-label^="About "]'
  );
  expect(infoTriggers.length).toBe(3);
  const infoNames = Array.from(infoTriggers).map((node) =>
    node.getAttribute("aria-label")
  );
  expect(infoNames).toContain("About Avg loop concurrency");
});

test("keeps the range toggle on the page even when the user is not found", async () => {
  // The toggle belongs to the page, not the user card: it must survive the
  // not-found state so a viewer can still change the window over the stats
  // that render below (FEA-4064).
  mockLoaded();

  const { container, getByText } = await renderPage();

  expect(getByText("User not found")).toBeTruthy();
  // The segmented control's pills carry the short range labels.
  const toggle = container.querySelector('[data-slot="toggle-group"]');
  expect(toggle).toBeTruthy();
  expect(toggle?.textContent).toContain("30d");
  expect(toggle?.textContent).toContain("1y");
});

test("labels the contributions heatmap with its own fixed trailing-year window", async () => {
  // The heatmap does not re-scope with the toggle by design, so it states its
  // own window and the range control does not read as broken (FEA-4064).
  mockLoaded();

  const { container } = await renderPage();

  const heatmapRegion = container.querySelector(
    'section[aria-labelledby="contributions-heading"]'
  ) as HTMLElement;
  const heatmapHeading = heatmapRegion.querySelector(
    "h3#contributions-heading"
  );
  expect(heatmapHeading?.textContent).toContain("Contributions");
  // The panel states its own trailing-year window next to the heading.
  expect(heatmapRegion.textContent).toContain("Past year");
});

test("holds the place of every tile and Activity panel while loading", async () => {
  mockUseUser.mockReturnValue({ data: null, isLoading: false });
  mockUseUserProfileHeadline.mockReturnValue({
    data: undefined,
    isLoading: true,
    isError: false,
  });
  mockUseUserContributionHeatmap.mockReturnValue({
    data: undefined,
    isLoading: true,
    isError: false,
  });
  // Standing/milestones resolved with no real data → both sections hidden, so
  // they add no skeletons and the count below stays scoped to headline+activity.
  mockUseUserProfileStanding.mockReturnValue({
    data: { streak: null },
    isLoading: false,
    isError: false,
  });
  mockUseUserProfileMilestones.mockReturnValue({
    data: { milestones: [] },
    isLoading: false,
    isError: false,
  });

  const { container } = await renderPage();

  // Eight tile skeletons + two Activity-panel skeletons, so neither region
  // reflows/jumps when stats resolve.
  const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
  expect(skeletons.length).toBe(10);

  // The Activity group keeps its heading and named landmark while loading.
  const activity = container.querySelector(
    'section[aria-labelledby="activity-heading"]'
  );
  expect(activity).not.toBeNull();
});

test("renders the headline metrics even when the contribution heatmap read fails (widget independence)", async () => {
  // FEA-4064: the two widgets load independently. A failing fixed-window heatmap
  // read must NOT blank the ranged headline numbers, and vice versa.
  mockUseUser.mockReturnValue({ data: null, isLoading: false });
  mockUseUserProfileHeadline.mockReturnValue({
    data: HEADLINE,
    isLoading: false,
    isError: false,
  });
  mockUseUserContributionHeatmap.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: true,
  });
  mockUseUserProfileStanding.mockReturnValue({
    data: { streak: null },
    isLoading: false,
    isError: false,
  });
  mockUseUserProfileMilestones.mockReturnValue({
    data: { milestones: [] },
    isLoading: false,
    isError: false,
  });

  const { container } = await renderPage();

  // Headline tiles still render with their real values.
  const headlines = container.querySelector(
    'section[aria-labelledby="headline-stats-heading"]'
  ) as HTMLElement;
  const values = Array.from(
    headlines.querySelectorAll('[data-slot="card-title"]')
  ).map((node) => node.textContent?.trim());
  expect(values).toContain("12");

  // The heatmap panel shows its own inline error, scoped to that widget.
  const heatmapRegion = container.querySelector(
    'section[aria-labelledby="contributions-heading"]'
  ) as HTMLElement;
  expect(heatmapRegion.textContent).toContain("Couldn't load contributions");
  // The heatmap sentinel is not rendered when its query failed.
  expect(heatmapRegion.querySelector('[data-testid="heatmap"]')).toBeNull();
});

test("renders the contribution heatmap even when the headline read fails (widget independence)", async () => {
  // The inverse: a failing ranged headline read must not blank the fixed-window
  // heatmap widget.
  mockUseUser.mockReturnValue({ data: null, isLoading: false });
  mockUseUserProfileHeadline.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: true,
  });
  mockUseUserContributionHeatmap.mockReturnValue({
    data: HEATMAP,
    isLoading: false,
    isError: false,
  });
  mockUseUserProfileStanding.mockReturnValue({
    data: { streak: null },
    isLoading: false,
    isError: false,
  });
  mockUseUserProfileMilestones.mockReturnValue({
    data: { milestones: [] },
    isLoading: false,
    isError: false,
  });

  const { container } = await renderPage();

  // The headline grid shows its own inline error rather than an infinite skeleton.
  const headlines = container.querySelector(
    'section[aria-labelledby="headline-stats-heading"]'
  ) as HTMLElement;
  expect(headlines.textContent).toContain("Couldn't load headline metrics");

  // The heatmap widget still renders with its real point count.
  const heatmap = container.querySelector(
    '[data-testid="heatmap"]'
  ) as HTMLElement;
  expect(heatmap.getAttribute("data-heatmap-points")).toBe(
    String(HEATMAP.contributionHeatmap.length)
  );
});

test("does not add its own main landmark — the authenticated shell owns it", async () => {
  // SidebarInset (the authenticated shell) already renders the single <main>
  // landmark, so this page body must be a plain <div>. A <main> here would give
  // the composed page two top-level landmarks.
  mockLoaded();

  const { container } = await renderPage();

  expect(container.querySelectorAll("main")).toHaveLength(0);
});

test("groups the content into labeled Headlines and Activity landmarks", async () => {
  mockLoaded();

  const { container } = await renderPage();

  // The prototype's IA: each top-level group is a section named by its own
  // heading via aria-labelledby, giving the page a designed read order rather
  // than one flat stat dump.
  const headlines = container.querySelector(
    'section[aria-labelledby="headline-stats-heading"]'
  );
  const activity = container.querySelector(
    'section[aria-labelledby="activity-heading"]'
  );

  expect(headlines).not.toBeNull();
  expect(activity).not.toBeNull();
  const activitySection = activity as HTMLElement;
  // The group is named by its own h2.
  expect(
    within(activitySection)
      .getByRole("heading", { level: 2 })
      .textContent?.trim()
  ).toContain("Activity");

  // Each chart is its own named region with a real h3 (Section's CardTitle was a
  // plain div, dropping both chart headings from screen-reader navigation).
  const chartHeadings = within(activitySection)
    .getAllByRole("heading", { level: 3 })
    .map((node) => node.textContent?.trim());
  expect(chartHeadings).toContain("Contributions");
  expect(chartHeadings).toContain("Artifacts by type");

  // Both charts render under Activity, each fed its OWN data prop — distinct
  // sentinels (echoing their point counts) prove neither is missing, swapped,
  // or sharing an array. The heatmap is fed by the fixed-window query and the
  // artifacts chart by the ranged headline query (FEA-4064).
  const heatmap = within(activitySection).getByTestId("heatmap");
  const documentsChart = within(activitySection).getByTestId("documents-chart");
  expect(heatmap.getAttribute("data-heatmap-points")).toBe(
    String(HEATMAP.contributionHeatmap.length)
  );
  expect(documentsChart.getAttribute("data-doctype-points")).toBe(
    String(HEADLINE.documentsByType.length)
  );
});
