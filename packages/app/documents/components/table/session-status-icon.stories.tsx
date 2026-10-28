import { ArtifactType } from "@repo/api/src/types/artifact";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { artifactFavoriteKeys } from "@repo/app/documents/hooks/artifact-favorite-keys";
import { FAILED_SESSION_STATUS_ICON_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { makeRawArtifact } from "@repo/app/shared/test-fixtures/documents";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { NameCell } from "./cells/name-cell";
import type { DocumentRowItem } from "./document-row";
import { DocumentCard, DocumentRow } from "./document-row";

/**
 * ISS-8692 — how the artifact table draws a session that FAILED.
 *
 * It used to draw the document-phase "Won't do" mark: a neutral X, the same
 * glyph a closed pull request gets one row above, announcing a deliberate
 * decision not to do the work. A run that crashed did not decide anything. The
 * `failed` status icon is the danger-toned BOLT — its own glyph, not the
 * `--warning` exclamation Blocked and Changes requested draw (ISS-6801
 * decision-maker, 2026-09-01) — and its own accessible name is the word the
 * row's caption already uses.
 *
 * Both layouts are on the canvas because they are one component: `DocumentRow`
 * measures its own container and hands the SAME `NameCell` cluster to a wide
 * grid row or, under `md`, to a card. The mapping has one answer, and this is
 * where you can see that both readers get it.
 */
const FAILED_SESSION: DocumentRowItem = {
  kind: "session",
  data: makeRawArtifact(ArtifactType.Session, {
    id: "ses-failed",
    name: "Nightly refactor run",
    status: SESSION_STATUS.ERROR,
  }),
};

const FAILED_CAPTION = SESSION_STATUS_LABELS[SESSION_STATUS.ERROR];

const meta = {
  title: "Primitives v1.0/Feedback & Status/Session Status Icon",
  component: DocumentRow,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "padded",
    appCore: {
      enabledFlags: [FAILED_SESSION_STATUS_ICON_FEATURE_FLAG_KEY],
      queryData: [[artifactFavoriteKeys.list(), []]],
    },
  },
  args: { item: FAILED_SESSION, visibleColumns: [] },
} satisfies Meta<typeof DocumentRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The wide layout: the grid row. */
export const FailedSessionGridRow: Story = {
  render: (args) => (
    <div style={{ width: GRID_WIDTH }}>
      <DocumentRow {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    // Which layout resolved is asserted first, so this case cannot pass on the
    // card's copy of the same cluster and quietly leave the grid uncovered.
    await expect(canvasElement.querySelector(CARD_SELECTOR)).toBeNull();
    await assertFailedMark(canvasElement);
  },
};

/**
 * The narrow layout: the card the row falls back to below `md`.
 *
 * Composed directly rather than by shrinking a `DocumentRow`, because the
 * fallback is chosen from a measured container width and a story canvas does
 * not measure — a narrowed row would keep painting the grid and this case would
 * be a second copy of the one above. The header is the same `NameCell` the grid
 * gets, which is the whole point: one cluster, one status mapping, two readers.
 */
export const FailedSessionCard: Story = {
  parameters: {
    controls: { include: ["item", "visibleColumns"] },
  },
  render: (args) => (
    <div style={{ width: CARD_WIDTH }}>
      <DocumentCard
        isSelected={false}
        item={args.item}
        moreMenu={null}
        nameCell={
          <NameCell isSelected={false} item={args.item} showCheckbox={false} />
        }
        visibleColumns={args.visibleColumns}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(CARD_SELECTOR)).not.toBeNull();
    await assertFailedMark(canvasElement);
  },
};

/**
 * What the row draws TODAY, with the rollout flag off — the neutral "Won't do"
 * X, under a caption that already reads "Failed". This is the state every user
 * currently sees, so it belongs on the canvas beside the fix rather than only
 * in the vitest suite: a designer opening this page to check the shipped
 * behaviour would otherwise find only the flagged-on version.
 */
export const FailedSessionGridRowFlagOff: Story = {
  parameters: {
    appCore: {
      enabledFlags: [],
      queryData: [[artifactFavoriteKeys.list(), []]],
    },
  },
  render: (args) => (
    <div style={{ width: GRID_WIDTH }}>
      <DocumentRow {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const icon = within(canvasElement).getByRole("img", {
      name: FAILED_CAPTION,
    });
    await expect(icon.querySelector(DANGER_FILL_SELECTOR)).toBeNull();
  },
};

/** Above the row's `md` card-fallback breakpoint. */
const GRID_WIDTH = 900;
/** Below it. */
const CARD_WIDTH = 360;
/** The card fallback's own root — `GridTableCard` builds on the DS `Card`. */
const CARD_SELECTOR = '[data-slot="card"]';
/** Danger styling, as the mark actually paints it. */
const DANGER_FILL_SELECTOR = '[fill="var(--destructive)"]';

/**
 * The row announces "Failed" and paints the failure mark.
 *
 * Both halves are needed. The row supplies the icon's accessible name, so the
 * name held even while the mark underneath it was the neutral "Won't do" X —
 * finding the icon by that name proves nothing on its own. The fill is what
 * changed, and it is the AC's danger styling; the SHAPE half of that AC is
 * pinned by `__tests__/document-row.session-status-icon.test.tsx`, which
 * compares the whole mark with fills erased.
 */
async function assertFailedMark(canvasElement: HTMLElement) {
  const icon = within(canvasElement).getByRole("img", { name: FAILED_CAPTION });
  await expect(icon.querySelector(DANGER_FILL_SELECTOR)).not.toBeNull();
}
