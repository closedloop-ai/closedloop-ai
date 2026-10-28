import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import {
  InlineNameCell,
  type InlineNameCellProps,
} from "@repo/design-system/components/ui/inline-name-cell";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";

const NAME = "session/nightly-collector-sweep";
const LABEL = "Edit name for this row";
const REFUSED_DRAFT = "refused in storybook";

/**
 * The grid-table editor for a record's NAME, and the sibling of
 * `InlineScalarCell` rather than a mode on it — operator ruling 2026-10-02:
 * "make it a separate sibling, the LLM won't be able to figure out the gated
 * opt-in; that's an antipattern".
 *
 * It composes that cell for the whole editing core and adds the three rules a
 * name needs: a trimmed commit, a blank draft that CANCELS rather than erases,
 * and a revealed rather than always-live field — a lead cell is also the row's
 * only link into the record, so a permanent text field leaves no link to click.
 *
 * Hover the row to reveal the pencil, or Tab to it.
 *
 * Two refusal policies: with `retainRejectedDraft` (and the host's
 * `saveErrorMessage`) a refused rename keeps the draft beside its error; without
 * it the editor closes on Enter and the previous name stays. The meta defaults
 * to the retained policy; Refused Rename Rolls Back shows the other one.
 *
 * States that do not apply, and why:
 *
 * - **Hover** is a CSS reveal (`group-hover`) with no DOM change, so it has no
 *   assertion; Keyboard Focus covers the same reveal through `focus-visible`.
 * - **Loading** has no state of its own: a write in flight keeps the field open
 *   (retained policy) or the previous name showing (compatibility policy).
 * - **Empty** does not exist for a name: a blank draft is a cancel (Blank Is A
 *   Cancel), and the routes behind one refuse `""`.
 * - **Disabled, read-only and no permission** are the host's: a viewer who may
 *   not rename gets the host's own node with no cell at all (Session Inline
 *   Rename, Owner Sees The Control).
 */
const meta = {
  title: "Composites/Shared/Artifact List/Inline Name Cell",
  component: InlineNameCell,
  tags: ["stable", "autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    className: { control: false },
    label: { control: "text" },
    onCommit: { control: false },
    renderValue: { control: false },
    retainRejectedDraft: { control: "boolean" },
    // The host's shared constant. A blank one is a programmer error the cell
    // throws on, so it is not authored from the panel.
    saveErrorMessage: { control: false },
    value: { control: "text" },
  },
  args: {
    label: LABEL,
    value: NAME,
    onCommit: fn(),
    retainRejectedDraft: true,
    saveErrorMessage: INLINE_EDIT_SAVE_ERROR_MESSAGE,
  },
} satisfies Meta<typeof InlineNameCell>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The resting cell: the host's own node, with the control revealed on hover. */
export const Default: Story = {
  render: (args) => (
    <div className="w-96">
      <InlineNameCell {...args} renderValue={renderLeadLink} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("link", { name: NAME })).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: LABEL })
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("textbox")).toBeNull();
  },
};

/**
 * The editing state: the field opens over the resting name, focused and fully
 * selected, because opening a field over a name offers to replace it.
 */
export const EditorOpen: Story = {
  render: (args) => (
    <div className="w-96">
      <InlineNameCell {...args} renderValue={renderLeadLink} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: LABEL })
    );
    const field = screen.getByRole<HTMLInputElement>("textbox", {
      name: LABEL,
    });
    await expect(field).toHaveValue(NAME);
    await expect(field).toHaveFocus();
    await expect(field.selectionStart).toBe(0);
    await expect(field.selectionEnd).toBe(NAME.length);
  },
};

/**
 * Keyboard only, no pointer: Tab passes the row's link and lands on the edit
 * control, which `focus-visible` reveals. The play stops there so the revealed
 * control is what the frame shows.
 */
export const KeyboardFocus: Story = {
  render: (args) => (
    <div className="w-96">
      <InlineNameCell {...args} renderValue={renderLeadLink} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole("link", { name: NAME })).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole("button", { name: LABEL })).toHaveFocus();
  },
};

/**
 * A REFUSED rename under the retained policy. The editor keeps the draft beside
 * its error so it can be corrected or retried without presenting the unsaved
 * text as persisted data.
 */
export const RefusedRenameRetainsDraft: Story = {
  name: "Refused Rename Retains Draft",
  tags: ["!manifest"],
  render: (args) => (
    <div className="w-96">
      <InlineNameCell
        {...args}
        onCommit={() => Promise.reject(new Error("the server refused it"))}
        renderValue={renderLeadLink}
      />
    </div>
  ),
  play: playRetainedRefusal,
};

/**
 * A REFUSED rename under the compatibility policy (no `retainRejectedDraft`):
 * the editor closes on Enter and the previous name stays, because nothing was
 * saved. `data-refusals` counts settled refusals so the play can wait for the
 * write to fail rather than for time to pass.
 */
export const RefusedRenameRollsBack: Story = {
  parameters: {
    controls: { exclude: ["retainRejectedDraft", "saveErrorMessage"] },
  },
  tags: ["!manifest"],
  render: (args) => (
    <RefusingCompatibilityCell
      label={args.label}
      onCommit={args.onCommit}
      value={args.value}
    />
  ),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: LABEL }));
    const field = screen.getByRole("textbox", { name: LABEL });
    await userEvent.clear(field);
    await userEvent.type(field, `${REFUSED_DRAFT}{Enter}`);
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-refusals="1"]')).not.toBeNull()
    );
    await expect(args.onCommit).toHaveBeenCalledWith(REFUSED_DRAFT, NAME);
    await expect(canvas.getByRole("link", { name: NAME })).toBeInTheDocument();
    await expect(canvas.queryByRole("textbox")).toBeNull();
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/**
 * A blank draft is a CANCEL. This is the rule that keeps this component and
 * `InlineScalarCell` separate: clearing a SCALAR is how a user unsets an
 * estimate or a custom text field, and a name has no such reading.
 */
export const BlankIsACancel: Story = {
  tags: ["!manifest"],
  render: (args) => (
    <div className="w-96">
      <InlineNameCell {...args} renderValue={renderLeadLink} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: LABEL }));
    const field = screen.getByRole("textbox", { name: LABEL });
    await userEvent.clear(field);
    await userEvent.type(field, "{Enter}");
    await expect(canvas.getByRole("link", { name: NAME })).toBeInTheDocument();
  },
};

/** Escape discards the typing and closes the field over the unchanged name. */
export const EscapeCancels: Story = {
  tags: ["!manifest"],
  render: (args) => (
    <div className="w-96">
      <InlineNameCell {...args} renderValue={renderLeadLink} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: LABEL }));
    const field = screen.getByRole("textbox", { name: LABEL });
    await userEvent.clear(field);
    await userEvent.type(field, "discarded draft{Escape}");
    await expect(canvas.getByRole("link", { name: NAME })).toBeInTheDocument();
    await expect(canvas.queryByRole("textbox")).toBeNull();
  },
};

/**
 * A committed rename, with NO host echo — the args never change. The new name
 * still appears, because the cell remembers what the write accepted; a resting
 * render keyed only on `value` would show the old name here.
 */
export const CommittedWithoutAHostEcho: Story = {
  tags: ["!manifest"],
  render: (args) => (
    <div className="w-96">
      <InlineNameCell
        {...args}
        onCommit={() => Promise.resolve()}
        renderValue={renderLeadLink}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: LABEL }));
    const field = screen.getByRole("textbox", { name: LABEL });
    await userEvent.clear(field);
    await userEvent.type(field, "renamed in storybook{Enter}");
    await expect(
      canvas.getByRole("link", { name: "renamed in storybook" })
    ).toBeInTheDocument();
  },
};

/**
 * Overflow in a narrow column: the host's link truncates and the edit control
 * keeps its place beside it rather than being pushed out of the cell.
 */
export const LongNameInANarrowColumn: Story = {
  args: {
    value:
      "session/nightly-collector-sweep-with-a-long-generated-branch-suffix",
  },
  tags: ["!manifest"],
  render: (args) => (
    <div className="w-40">
      <InlineNameCell {...args} renderValue={renderLeadLink} />
    </div>
  ),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("link", { name: args.value })
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: LABEL })
    ).toBeInTheDocument();
  },
};

/** The retained refusal in the dark theme: the error beside the kept draft. */
export const Dark: Story = {
  globals: { theme: "dark" },
  tags: ["!manifest"],
  render: (args) => (
    <div className="w-96">
      <InlineNameCell
        {...args}
        onCommit={() => Promise.reject(new Error("the server refused it"))}
        renderValue={renderLeadLink}
      />
    </div>
  ),
  play: playRetainedRefusal,
};

/** The resting render a lead cell supplies: the row's link into the record. */
function renderLeadLink(shown: string) {
  return (
    <a className="block truncate text-foreground hover:underline" href="#lead">
      {shown}
    </a>
  );
}

async function playRetainedRefusal({
  canvasElement,
}: Readonly<{ canvasElement: HTMLElement }>) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: LABEL }));
  const field = screen.getByRole("textbox", { name: LABEL });
  await userEvent.clear(field);
  await userEvent.type(field, `${REFUSED_DRAFT}{Enter}`);
  await expect(field).toHaveValue(REFUSED_DRAFT);
  await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
  await expect(field).toHaveAccessibleDescription(
    INLINE_EDIT_SAVE_ERROR_MESSAGE
  );
  await expect(
    canvas.getByRole("alert", { name: INLINE_EDIT_SAVE_ERROR_MESSAGE })
  ).toBeInTheDocument();
}

/** A compatibility-policy cell whose every write is refused, counted. */
function RefusingCompatibilityCell({
  label,
  onCommit,
  value,
}: Readonly<
  Pick<InlineNameCellProps, "label" | "value"> & {
    onCommit: InlineNameCellProps["onCommit"];
  }
>) {
  const [refusals, setRefusals] = useState(0);
  return (
    <div className="w-96" data-refusals={refusals}>
      <InlineNameCell
        label={label}
        onCommit={(next, expectedValue) => {
          onCommit(next, expectedValue);
          const refused = Promise.reject(new Error("the server refused it"));
          refused.catch(() => setRefusals((count) => count + 1));
          return refused;
        }}
        renderValue={renderLeadLink}
        value={value}
      />
    </div>
  );
}
