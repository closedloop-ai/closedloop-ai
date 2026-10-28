import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { type CollaboratorPerson, Collaborators } from "./collaborators";

/**
 * The Collaborators widget, lifted from the Branches list cell (ISS-12267) so
 * every surface that shows collaborators can mount the same one: up to three avatars, then the overflow count,
 * with the full list as the accessible name.
 *
 * Controls: none. Each story is one fixed set of people, so the sandbox cannot
 * assemble a list the projection never emits.
 */
/** A data URI, so the story needs no network and the src is assertable. */
const PHOTO_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3C/svg%3E";

const THREE: CollaboratorPerson[] = [
  { key: "morgan", name: "Morgan Fixture" },
  { key: "pascoe", name: "Pascoe Fixture" },
  { key: "sam", name: "Sam Fixture" },
];
const SIX: CollaboratorPerson[] = [
  ...THREE,
  { key: "alice", name: "Alice Fixture" },
  { key: "dana", name: "Dana Fixture" },
  { key: "jordan", name: "Jordan Fixture" },
];

const meta = {
  title: "Composites v1.0/App Shell/Collaborators",
  component: Collaborators,
  tags: ["deprecated", "autodocs"],
  parameters: { controls: { disable: true }, layout: "padded" },
  args: { people: THREE },
} satisfies Meta<typeof Collaborators>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("img", {
        name: "Morgan Fixture, Pascoe Fixture, Sam Fixture",
      })
    ).toBeInTheDocument();
  },
};

/** More than three people: three avatars, then how many more. */
export const Overflow: Story = { args: { people: SIX } };

/**
 * ISS-12273: one human reported by two sources draws once and counts once —
 * and two DIFFERENT people who share a display name both still draw, which is
 * why the dedupe reads `key` and never the name (PR #8461).
 */
export const DuplicateIdentity: Story = {
  args: {
    people: [
      ...THREE,
      { key: "morgan", name: "Morgan Fixture" },
      { key: "alex-one", name: "Alex Smith" },
      { key: "alex-two", name: "Alex Smith" },
    ],
  },
  play: async ({ canvasElement }) => {
    // Five people, not six: `morgan` is listed twice. Both Alex Smiths survive,
    // so the name is provably not the identity.
    await expect(
      within(canvasElement).getByRole("img", {
        name: "Morgan Fixture, Pascoe Fixture, Sam Fixture, Alex Smith, Alex Smith",
      })
    ).toBeInTheDocument();
    // Three drawn, so the overflow states the other two.
    await expect(within(canvasElement).getByText("+2")).toBeInTheDocument();
  },
};

export const One: Story = { args: { people: THREE.slice(0, 1) } };

/**
 * ISS-12273 / ISS-12269 change 4: a photo where the producer has one, initials
 * where it does not, in the same stack.
 *
 * The play asserts only what jsdom can: Radix mounts `AvatarImage` on LOAD, and
 * jsdom loads nothing, so a rendered photo is NOT provable here. That evidence
 * is `e2e/session-detail-shell.spec.ts`, in a real browser — the acceptance
 * evidence for the inherited avatar scope has to be a rendered picture, not the
 * widget merely receiving a url.
 */
export const WithPhotos: Story = {
  args: {
    people: [
      { avatarUrl: PHOTO_SRC, key: "morgan", name: "Morgan Fixture" },
      { key: "sam", name: "Sam Fixture" },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Both people are stated whether or not a photo exists for them.
    await expect(
      canvas.getByRole("img", { name: "Morgan Fixture, Sam Fixture" })
    ).toBeInTheDocument();
    // One initial on every avatar (Nerys, 2026-10-22).
    await expect(canvas.getByText("S")).toBeInTheDocument();
  },
};

/** No collaborators: the grid's own empty mark. */
export const Empty: Story = { args: { people: [] } };
