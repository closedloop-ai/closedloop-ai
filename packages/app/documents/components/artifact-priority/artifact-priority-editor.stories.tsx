import { Priority } from "@repo/api/src/types/common";
import type { Document } from "@repo/api/src/types/document";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import type { ArtifactRowEditInput } from "@repo/app/documents/hooks/use-artifact-row-edit";
import { useArtifactRowEdit } from "@repo/app/documents/hooks/use-artifact-row-edit";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  ARTIFACT_PRIORITY_SUPPORT,
  type ArtifactPrioritySupport,
  ArtifactPrioritySurface,
  ArtifactPriorityVariant,
} from "@repo/app/shared/lib/artifact-priority-ownership";
import { ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { makeFeatureArtifact } from "@repo/app/shared/test-fixtures/documents";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";

const ARTIFACT_SUPPORT =
  ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Artifact];
/**
 * SYNTHETIC: since ISS-10332 made Branches and Sessions carry priority, no
 * shipped surface is unsupported, so this is a declaration of the shape the
 * map still admits.
 */
const UNSUPPORTED_SUPPORT: ArtifactPrioritySupport = {
  adapter: "story",
  reason: "carries no priority",
  supported: false,
};

/** How the single-path test finds every priority mark on a champion surface. */
const CHAMPION = '[data-slot="artifact-priority"]';

/** Opens the gate the editing and mutation-activity treatments wait behind. */
const CHAMPION_UI_ADAPTER = createStaticFeatureFlagAdapter({
  enabledFlags: [ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY],
});

/**
 * `ArtifactPriorityEditor` is the one control that CHANGES an artifact's
 * priority (ISS-9307). `ArtifactPriority` next door paints the value and is
 * inert on purpose; every story here is about whether a control exists at all,
 * and what the reader is told while a write is out.
 *
 * The branches, and the three that are easy to conflate:
 *
 * - **support** — the operator ruling of 2026-09-11 is that priority is an
 *   ARTIFACT field. A surface whose `ARTIFACT_PRIORITY_SUPPORT` entry is
 *   unsupported never gets a control, whatever else the caller passes. It still
 *   paints the mark, so "no control" is never satisfied by rendering nothing.
 * - **read-only** — the surface supports priority and the row is still not
 *   editable, for either of two independent reasons: the caller said `readOnly`,
 *   or it supplied no commit path.
 * - **disabled** — a third, separate reason.
 * - **pending / rollback** — a real write, in flight and then refused. Both
 *   belong to `useArtifactRowEdit`; the editor keeps no accepted copy of its
 *   own, which is what lets the row put back a value the server refused.
 *
 * Every story drives the production hook rather than a stub handler, so a
 * treatment shown here is one a real surface can actually produce.
 *
 * The activity treatments sit behind `artifact-priority-surfaces` (ISS-4779,
 * closed by default) and `ArtifactPriority` reads that key itself, so the two
 * stories that show them mount an adapter with the key open. Without one they
 * would render settled while claiming otherwise.
 */
const meta = {
  args: {
    priority: Priority.Low,
    support: ARTIFACT_SUPPORT,
    variant: ArtifactPriorityVariant.Editor,
  },
  component: ArtifactPriorityEditor,
  parameters: { layout: "padded" },
  tags: ["deprecated", "autodocs"],
  title: "Primitives v1.0/Data Display/Artifact Priority Editor",
} satisfies Meta<typeof ArtifactPriorityEditor>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The editable row: the whole mark is the trigger, and picking commits. */
export const Editable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "Priority: Low" });
    // What tells a screen reader the mark is a control. There is no caret.
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(trigger);
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Urgent" })
    );

    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Priority: Urgent" })
      ).toBeTruthy()
    );
  },
  render: () => <LiveRow caption="editable" />,
};

/**
 * A surface that carries no priority column. The ruling is enforced by the
 * component, not by each call site remembering it.
 */
export const NotSupported: Story = {
  play: ({ canvasElement }) => {
    expect(within(canvasElement).queryByRole("button")).toBeNull();
    // The sibling positive: the mark is still painted, so this cannot pass on a
    // component that rendered nothing at all.
    expect(canvasElement.querySelector(CHAMPION)).not.toBeNull();
  },
  render: () => (
    <LiveRow caption="unsupported surface" support={UNSUPPORTED_SUPPORT} />
  ),
};

/**
 * The two read-only reasons that are NOT about support. They look identical and
 * are reached differently, which is why both are here.
 */
export const ReadOnly: Story = {
  play: ({ canvasElement }) => {
    expect(within(canvasElement).queryAllByRole("button")).toHaveLength(0);
    expect(canvasElement.querySelectorAll(CHAMPION)).toHaveLength(2);
  },
  render: () => (
    <div className="space-y-2">
      <LiveRow caption="readOnly" readOnly />
      <LiveRow caption="no commit path" withCommitPath={false} />
    </div>
  ),
};

/** The third reason to withhold the control. */
export const Disabled: Story = {
  play: ({ canvasElement }) => {
    expect(within(canvasElement).queryByRole("button")).toBeNull();
    expect(canvasElement.querySelector(CHAMPION)).not.toBeNull();
  },
  render: () => <LiveRow caption="disabled" disabled />,
};

/**
 * A write that is genuinely out: the mark quiets and publishes `aria-busy`
 * rather than looking settled while the server has not answered.
 */
export const WriteInFlight: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Settled first, so the busy assertion cannot be satisfied by a mark that
    // always sets the attribute.
    expect(canvasElement.querySelector(CHAMPION)).not.toHaveAttribute(
      "aria-busy"
    );

    await userEvent.click(
      canvas.getByRole("button", { name: "Priority: Low" })
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Urgent" })
    );

    await waitFor(() =>
      expect(canvasElement.querySelector(CHAMPION)).toHaveAttribute(
        "aria-busy",
        "true"
      )
    );
  },
  render: () => (
    <Gated>
      <LiveRow caption="write in flight" commit={unsettled} />
    </Gated>
  ),
};

/**
 * The refused write. The row showed the picked value optimistically, the server
 * said no, and what the reader is left with is the artifact's real value — not
 * the one it was denied, and not a row still announcing a write that is over.
 */
export const RefusedWrite: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Priority: Low" })
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Urgent" })
    );

    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Priority: Low" })).toBeTruthy()
    );
    expect(
      canvas.queryByRole("button", { name: "Priority: Urgent" })
    ).toBeNull();
    // Cleared by the same settle that rolled the value back. A row that put the
    // value back while still reading busy would stay dimmed for its whole life.
    expect(canvasElement.querySelector(CHAMPION)).not.toHaveAttribute(
      "aria-busy"
    );
  },
  render: () => (
    <Gated>
      <LiveRow caption="refused write" commit={refuse} />
    </Gated>
  ),
};

/** A write the server never answers, so the in-flight state stays observable. */
const unsettled = () => new Promise<unknown>(() => undefined);

const refuse = () => Promise.reject(new Error("refused"));

const accept = () => Promise.resolve({});

function Gated({ children }: { children: ReactNode }) {
  return (
    <FeatureFlagAdapterProvider adapter={CHAMPION_UI_ADAPTER}>
      {children}
    </FeatureFlagAdapterProvider>
  );
}

/**
 * The production wiring: the same hook every grid row and artifact row uses,
 * driving the same editor. The optimistic value, the in-flight mark and the
 * rollback all come from it, so nothing shown here is a handler standing in for
 * a state transition the surface cannot really reach.
 */
function LiveRow({
  caption,
  commit = accept,
  disabled,
  readOnly,
  support = ARTIFACT_SUPPORT,
  withCommitPath = true,
}: {
  caption: string;
  commit?: (input: ArtifactRowEditInput) => Promise<unknown>;
  disabled?: boolean;
  readOnly?: boolean;
  support?: ArtifactPrioritySupport;
  /** `false` is the surface that supplies no way to write — read-only reason two. */
  withCommitPath?: boolean;
}) {
  const edit = useArtifactRowEdit(ARTIFACT, { commit });
  return (
    <div className="flex items-center gap-4">
      <span className="w-40 shrink-0 text-muted-foreground text-xs">
        {caption}
      </span>
      <ArtifactPriorityEditor
        disabled={disabled}
        mutationActivity={edit.priorityPending}
        onSelect={withCommitPath ? edit.onPriorityChange : undefined}
        priority={edit.priority}
        readOnly={readOnly}
        support={support}
        variant={ArtifactPriorityVariant.Editor}
      />
    </div>
  );
}

/** The shared grid fixture, so this row is the shape the production rows are. */
const ARTIFACT: Document = makeFeatureArtifact({ priority: Priority.Low });
