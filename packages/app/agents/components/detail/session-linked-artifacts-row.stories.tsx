import type { SessionLinkedArtifact } from "@repo/api/src/types/agent-session";
import { DocumentType } from "@repo/api/src/types/document";
import {
  getDocumentTypeRoute,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";
import type { Meta, StoryObj } from "@storybook/react";
import { SessionLinkedArtifactsRow } from "./session-linked-artifacts-row";
import { SessionPropertiesFrame } from "./session-properties-story-frame";

// A synthetic org slug so the story's hrefs match the production shape
// (`/{orgSlug}/{typePrefix}/{slug}`) rather than a machine-specific value.
const FIXTURE_ORG_SLUG = "acme" as const;

function makeArtifact(
  overrides: Partial<SessionLinkedArtifact> & Pick<SessionLinkedArtifact, "id">
): SessionLinkedArtifact {
  return {
    slug: null,
    name: null,
    documentType: null,
    role: null,
    ...overrides,
  };
}

// Under the six-pill cap: every link renders as a navigable pill, no overflow.
const underCapArtifacts: SessionLinkedArtifact[] = [
  makeArtifact({
    id: "art-1",
    slug: "FEA-4550",
    name: "Storybook coverage for session-linked-artifacts-row",
    documentType: DocumentType.Feature,
    role: "input",
  }),
  makeArtifact({
    id: "art-2",
    slug: "PRD-567",
    name: "Read-only logical-QA pack",
    documentType: DocumentType.Prd,
    role: "referenced",
  }),
  makeArtifact({
    id: "art-3",
    slug: "PLN-810",
    name: "Shared @repo/app package extraction plan",
    documentType: DocumentType.ImplementationPlan,
    role: "referenced",
  }),
];

// Enough resolved links to spill past the six-pill cap. The projection still
// carries every hidden link, so the `+N` chip's tooltip can name all of them.
const overflowNamedArtifacts: SessionLinkedArtifact[] = [
  makeArtifact({
    id: "over-1",
    slug: "FEA-4550",
    name: "Storybook coverage for session-linked-artifacts-row",
    documentType: DocumentType.Feature,
    role: "input",
  }),
  makeArtifact({
    id: "over-2",
    slug: "FEA-4449",
    documentType: DocumentType.Feature,
  }),
  makeArtifact({
    id: "over-3",
    slug: "FEA-4448",
    documentType: DocumentType.Feature,
  }),
  makeArtifact({
    id: "over-4",
    slug: "PRD-495",
    documentType: DocumentType.Prd,
  }),
  makeArtifact({
    id: "over-5",
    slug: "PRD-498",
    documentType: DocumentType.Prd,
  }),
  makeArtifact({
    id: "over-6",
    slug: "PRD-516",
    documentType: DocumentType.Prd,
  }),
  makeArtifact({
    id: "over-7",
    slug: "PLN-721",
    documentType: DocumentType.ImplementationPlan,
  }),
  makeArtifact({
    id: "over-8",
    slug: "PLN-722",
    documentType: DocumentType.ImplementationPlan,
  }),
  makeArtifact({
    id: "over-9",
    slug: "PLN-773",
    documentType: DocumentType.ImplementationPlan,
  }),
];

// Mirror the production href builder (sessions/[id]/page.tsx): compose the
// type-specific org-relative route with the org slug, so a browser-deferred
// click on a navigable pill resolves to the same path the app would navigate
// to. Null (non-clickable label) when the slug is absent or the type is not
// navigable — matching production for e.g. a Template.
function buildArtifactHref(artifact: SessionLinkedArtifact): string | null {
  return withOrgSlug(
    FIXTURE_ORG_SLUG,
    getDocumentTypeRoute(artifact.documentType, artifact.slug)
  );
}

// Recreate the production Properties-pane scope (agent-session-detail-view.tsx:
// the `.prd-props-section.sd3-props` section wrapping the `.prd-props` grid
// card) so the row's descendant-selector styling actually applies. The pill
// (`.sd3-result-pr`), the linked-prop label alignment (`.sd3-linked-prop`), and
// the `+N` overflow chip (`.sd3-linked-overflow`) are all defined under
// `.sd3-props` in packages/app/styles.css; without that ancestor the stories
// render unstyled and give no visual coverage for wrapping/overflow. The
// `.prd-props` grid is `auto-fit minmax(min(100%, 300px), 1fr)`, so the pane's
// own single-column min drives the width — no hard-coded pixel value needed.

const meta = {
  title: "App Core/Agents/Session Linked Artifacts Row",
  component: SessionLinkedArtifactsRow,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <SessionPropertiesFrame>
        <Story />
      </SessionPropertiesFrame>
    ),
  ],
} satisfies Meta<typeof SessionLinkedArtifactsRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The common case: fewer linked artifacts than the six-pill cap, so every link
 * renders inline as a navigable pill and no `+N` overflow chip appears.
 */
export const UnderCap: Story = {
  args: {
    linkedArtifacts: underCapArtifacts,
    total: underCapArtifacts.length,
    buildArtifactHref,
  },
};

/**
 * More resolved links than the cap, but the projection carried all of them. The
 * `+N` overflow chip's tooltip names every hidden artifact — hover the chip to
 * see the full list, with no "and K more…" line because nothing was dropped.
 */
export const OverflowChipNamesHidden: Story = {
  args: {
    linkedArtifacts: overflowNamedArtifacts,
    total: overflowNamedArtifacts.length,
    buildArtifactHref,
  },
};

/**
 * The truncation-honesty case (PR #3984): the true resolved `total` exceeds the
 * links the projection actually shipped, so the `+N` chip counts the real total
 * while its tooltip names the hidden links it received and adds an honest "and K
 * more…" line for the ones it never got — instead of implying it can name links
 * it never sent.
 */
export const TruncatedBeyondReceived: Story = {
  args: {
    linkedArtifacts: overflowNamedArtifacts,
    // The session resolved to far more links than the projection shipped; the
    // chip must report the real total and admit the extras it cannot name.
    total: 42,
    buildArtifactHref,
  },
};

/**
 * ISS-5366 (wongk review): the FOURTH visual state, and the only one that
 * asserts nothing.
 *
 * The other three stories all show settled answers — a navigable pill, an inert
 * "not reachable" label, an overflow chip. This is the desktop renderer's cold
 * mount, where the org slug and the web-app origin are both still in flight over
 * IPC, so the shell cannot yet say whether these artifacts are reachable. It
 * therefore passes NO href builder (exactly as the production shell does while
 * unresolved) and raises `artifactHrefPending`, and the pills render as
 * `aria-busy` spans with a reduced-opacity pulse and a "checking link…" tooltip.
 *
 * Without this state the load window rendered the settled-unreachable label and
 * then flipped to links — the row asserting "not reachable" about artifacts that
 * were reachable all along. Compare against `UnderCap` (the same artifacts, once
 * the shell resolves) to see the two apart at rest.
 *
 * The pulse honors `prefers-reduced-motion`, so with that setting on the pills
 * hold a static dimmed state instead of animating.
 */
export const Pending: Story = {
  args: {
    linkedArtifacts: underCapArtifacts,
    total: underCapArtifacts.length,
    // Deliberately no `buildArtifactHref`: an unresolved shell has nothing to
    // build a destination from, and the pending branch is only reachable when
    // there is no href to render instead.
    artifactHrefPending: true,
  },
};

/**
 * No linked artifacts: the row renders nothing so a session with none adds no
 * extra line to the Properties pane. The frame stays empty on purpose.
 */
export const Empty: Story = {
  args: {
    linkedArtifacts: [],
    total: 0,
    buildArtifactHref,
  },
};
