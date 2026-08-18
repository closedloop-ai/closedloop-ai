import {
  type SavedViewOption,
  TableSavedViewsSwitcher,
} from "@repo/design-system/components/ui/table-saved-views-switcher";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, screen, userEvent, within } from "storybook/test";

const ACTIVE_VIEW_NAME = "My open branches";
const SECOND_VIEW_NAME = "Awaiting review";
const TRIGGER_LABEL = "Branch views";
// The component's own default, asserted by the NoSavedViews story.
const DEFAULT_TRIGGER_LABEL = "Saved views";
const MODIFIED_MARKER = "• Modified";
// Typographic quotes, as the component renders them.
const UPDATE_ITEM_LABEL = `Update “${ACTIVE_VIEW_NAME}”`;
// Single-character ellipsis, as the component renders it.
const SAVE_AS_NEW_LABEL = "Save as new view…";

const initialViews: SavedViewOption[] = [
  { id: "view-mine", name: ACTIVE_VIEW_NAME },
  { id: "view-review", name: SECOND_VIEW_NAME },
  { id: "view-merged", name: "Recently merged" },
];

function TableSavedViewsSwitcherDemo({
  initialActiveViewId = "view-mine",
  initialModified = true,
  withUpdateView = true,
}: {
  initialActiveViewId?: string | null;
  initialModified?: boolean;
  withUpdateView?: boolean;
}) {
  const [views, setViews] = useState(initialViews);
  const [activeViewId, setActiveViewId] = useState<string | null>(
    initialActiveViewId
  );
  // Stand in for "the live table has diverged from the saved view" so the demo
  // shows the modified marker + Update item; switching a view resets it.
  const [modified, setModified] = useState(initialModified);

  return (
    <TableSavedViewsSwitcher
      activeViewId={activeViewId}
      modified={modified}
      onCreateView={(name) => {
        const id = `view-${views.length + 1}`;
        setViews((current) => [...current, { id, name }]);
        setActiveViewId(id);
        setModified(false);
      }}
      onDeleteView={(id) => {
        setViews((current) => current.filter((view) => view.id !== id));
        setActiveViewId((current) => (current === id ? null : current));
      }}
      onRenameView={(id, name) =>
        setViews((current) =>
          current.map((view) => (view.id === id ? { ...view, name } : view))
        )
      }
      onSelectView={(id) => {
        setActiveViewId(id);
        setModified(false);
      }}
      onUpdateView={withUpdateView ? () => setModified(false) : undefined}
      triggerLabel={TRIGGER_LABEL}
      views={views}
    />
  );
}

const meta = {
  title: "Design System/Primitives/Table Saved Views Switcher",
  component: TableSavedViewsSwitcherDemo,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof TableSavedViewsSwitcherDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The trigger names the active view AND qualifies it, so the label never
    // claims the table sits exactly on the saved snapshot once it has diverged.
    await expect(
      canvas.getByRole("button", { name: TRIGGER_LABEL })
    ).toHaveTextContent(`Views: ${ACTIVE_VIEW_NAME}`);
    await expect(
      canvas.getByRole("button", { name: TRIGGER_LABEL })
    ).toHaveTextContent(MODIFIED_MARKER);

    await userEvent.click(canvas.getByRole("button", { name: TRIGGER_LABEL }));

    // Committing the divergence into the view clears it: same name, no marker.
    await userEvent.click(
      await screen.findByRole("menuitem", { name: UPDATE_ITEM_LABEL })
    );

    const trigger = canvas.getByRole("button", { name: TRIGGER_LABEL });
    await expect(trigger).toHaveTextContent(`Views: ${ACTIVE_VIEW_NAME}`);
    await expect(trigger).not.toHaveTextContent(MODIFIED_MARKER);
  },
};

/**
 * `modified` is IGNORED on the default arrangement: there is no saved snapshot
 * to have diverged from, so the trigger must not claim one. This is precedence
 * a pixel diff cannot adjudicate — it renders a plausible control either way
 * and asks a human which one is correct.
 */
export const ModifiedOnDefaultView: Story = {
  args: {
    initialActiveViewId: null,
    initialModified: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: TRIGGER_LABEL });

    await expect(trigger).toHaveTextContent("Views: Default view");
    await expect(trigger).not.toHaveTextContent(MODIFIED_MARKER);

    await userEvent.click(trigger);
    await expect(
      await screen.findByRole("menuitem", { name: SAVE_AS_NEW_LABEL })
    ).toBeVisible();
    await expect(
      screen.queryByRole("menuitem", { name: UPDATE_ITEM_LABEL })
    ).not.toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
  },
};

export const SwitchingViewClearsModified: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: TRIGGER_LABEL }));

    // Switching adopts the NEW view's snapshot, so the previous view's
    // divergence marker must not carry over to it.
    await userEvent.click(
      await screen.findByRole("menuitemradio", { name: SECOND_VIEW_NAME })
    );

    const trigger = canvas.getByRole("button", { name: TRIGGER_LABEL });
    await expect(trigger).toHaveTextContent(`Views: ${SECOND_VIEW_NAME}`);
    await expect(trigger).not.toHaveTextContent(MODIFIED_MARKER);
  },
};

export const NoSavedViews: Story = {
  render: () => (
    <TableSavedViewsSwitcher
      activeViewId={null}
      onCreateView={() => undefined}
      onDeleteView={() => undefined}
      onRenameView={() => undefined}
      onSelectView={() => undefined}
      views={[]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", {
      name: DEFAULT_TRIGGER_LABEL,
    });

    await expect(trigger).toHaveTextContent("Views: Default view");
    await userEvent.click(trigger);

    // With no views there is only the default entry. The update item is absent
    // because there is no active view to have diverged FROM, not because
    // `onUpdateView` was omitted — with `activeViewId` null, `isModified` is
    // already false and suppresses it independently. `WithoutUpdateAction`
    // isolates the omission itself.
    await expect(await screen.findAllByRole("menuitemradio")).toHaveLength(1);
    await expect(
      screen.getByRole("menuitemradio", { name: "Default view" })
    ).toBeChecked();
    await expect(
      screen.queryByRole("menuitem", { name: UPDATE_ITEM_LABEL })
    ).not.toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
  },
};

/**
 * `onUpdateView` omitted while a view IS active and HAS diverged — the only
 * configuration where the omission is the sole reason the update item is
 * missing, so it is the only one that can prove the omission is honoured.
 */
export const WithoutUpdateAction: Story = {
  args: {
    withUpdateView: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: TRIGGER_LABEL });

    // The divergence marker still shows: only the ACTION is withheld, so the
    // trigger is not silently claiming the table matches the saved view.
    await expect(trigger).toHaveTextContent(MODIFIED_MARKER);

    await userEvent.click(trigger);
    await expect(
      await screen.findByRole("menuitem", { name: SAVE_AS_NEW_LABEL })
    ).toBeVisible();
    await expect(
      screen.queryByRole("menuitem", { name: UPDATE_ITEM_LABEL })
    ).not.toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
  },
};
