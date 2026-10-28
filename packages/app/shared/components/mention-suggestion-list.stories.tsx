import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import type { MentionUser } from "../lib/mentions";
import {
  MentionSuggestionList,
  type MentionSuggestionListProps,
} from "./mention-suggestion-list";

/**
 * The @-mention member menu the comment composer and the document editor's
 * body picker share (PLN-2189 T-2.8). Each story outlines the anchor the menu
 * opens against, because placement and width are what the stories pin.
 */
const MEMBERS: MentionUser[] = [
  {
    id: "u1",
    firstName: "Annie",
    lastName: "Case",
    email: "annie@example.com",
    active: true,
  },
  {
    id: "u2",
    firstName: "Bo",
    lastName: "Diaz",
    email: "bo@example.com",
    active: true,
  },
  {
    id: "u3",
    firstName: null,
    lastName: null,
    email: "no-name@example.com",
    active: true,
  },
];

const TEXTAREA_ANCHOR = new DOMRect(24, 24, 320, 64);
const CARET_ANCHOR = new DOMRect(24, 24, 0, 18);

const meta = {
  title: "Composites/Shared/Activity/Mention Suggestion List",
  tags: ["experimental"],
  component: MentionSuggestionList,
  parameters: { layout: "fullscreen" },
  args: {
    suggestions: MEMBERS,
    anchorRect: TEXTAREA_ANCHOR,
    onSelect: fn(),
  },
  argTypes: {
    suggestions: {
      control: "object",
      description: "The members listed, one row each, in order.",
    },
    anchorRect: {
      control: false,
      description:
        "A DOMRect, which no control can edit; each story sets the anchor.",
    },
    activeIndex: {
      control: { type: "number", min: 0 },
      description:
        "The keyboard-highlighted row. Set, the menu is a listbox; unset, the rows are plain buttons.",
    },
    matchAnchorWidth: {
      control: "boolean",
      description: "Size the menu to the anchor's width; off for a caret.",
    },
    onSelect: { control: false },
  },
  render: (args) => <AnchoredMenu {...args} />,
} satisfies Meta<typeof MentionSuggestionList>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The comment composer: plain button rows, as wide as the textarea. */
export const Default: Story = {};

/** The document editor's body picker: a listbox at the caret, row 2 active. */
export const CaretListbox: Story = {
  args: {
    anchorRect: CARET_ANCHOR,
    activeIndex: 1,
    matchAnchorWidth: false,
  },
};

/** Too little room below the anchor, so the menu flips above it. */
export const OpensAbove: Story = {
  render: (args) => (
    <AnchoredMenu
      {...args}
      anchorRect={new DOMRect(24, globalThis.innerHeight - 88, 320, 64)}
    />
  ),
};

/** Long names and emails truncate inside the caret menu's fixed width. */
export const LongText: Story = {
  args: {
    anchorRect: CARET_ANCHOR,
    matchAnchorWidth: false,
    suggestions: [
      {
        id: "u4",
        firstName: "Maximiliana Alexandrina",
        lastName: "Featherstonehaugh-Montgomery",
        email: "maximiliana.featherstonehaugh-montgomery@example.com",
        active: true,
      },
      ...MEMBERS,
    ],
  },
};

function AnchoredMenu(props: MentionSuggestionListProps) {
  const { anchorRect } = props;
  return (
    <>
      <div
        aria-hidden="true"
        className="fixed rounded-md border border-dashed"
        style={{
          left: anchorRect.left,
          top: anchorRect.top,
          width: Math.max(anchorRect.width, 1),
          height: anchorRect.height,
        }}
      />
      <MentionSuggestionList {...props} />
    </>
  );
}
