import type { AvatarSize } from "@repo/design-system/components/ui/avatar";
import { PersonAvatar } from "@repo/design-system/components/ui/person-avatar";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";

// Avatar, as Figma has it (Avatar component set, Nerys 2026-10-22):
// `PersonAvatar`, the avatar every person in the app gets, in seven sizes,
// a photo or a one-letter placeholder, and an optional online dot. Every
// person avatar uses the same placeholder colours: Zinc/200 behind Zinc/950
// in light, Zinc/700 behind Zinc/50 in dark; the dot is Green/600 (light)
// or Green/800 (dark), ringed in Zinc/300. Was "Person Avatar" until
// 2026-10-22; the old v1.0 Avatar entry stays under Primitives v1.0.
//
// Controls table:
// | Prop | Control | Why |
// |---|---|---|
// | size | select | the seven Figma sizes; the circle and the letter follow it |
// | online | boolean | the status dot |
// | name | text | the placeholder draws its first letter |
// | avatarUrl | text | a photo; empty shows the letter |
// | initials | text | a record's own initials; drawn as one letter |
// | ariaLabel, decorative, imageAlt | text / boolean | the naming contract |
// No-control table:
// | Prop | Reason |
// |---|---|
// | className, imageClassName, fallbackClassName | sizes and colours are the avatar's own |
// | role | a role without ariaLabel is unnamed; the named state pins the pair |

const SIZES: readonly AvatarSize[] = [
  "2xs",
  "xs",
  "sm",
  "md",
  "lg",
  "xl",
  "2xl",
];

const PHOTO_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23e9d5c4'/%3E%3Ccircle cx='32' cy='25' r='11' fill='%23356b62'/%3E%3Cpath d='M10 64c3-16 11-23 22-23s19 7 22 23' fill='%23356b62'/%3E%3C/svg%3E";
const FAILED_PHOTO_URL = "data:image/png;base64,broken";
const ONLY_A = /^A$/;

const meta = {
  title: "Primitives/Data Display/Avatar",
  component: PersonAvatar,
  tags: ["stable", "autodocs"],
  parameters: { layout: "centered" },
  args: {
    name: "Avery Carter",
    ariaLabel: "Avery Carter",
    role: "img",
    size: "md",
    online: false,
  },
  argTypes: {
    size: { control: "select", options: SIZES, table: { category: "Size" } },
    online: { control: "boolean", table: { category: "Status" } },
    name: { control: "text", table: { category: "Identity" } },
    avatarUrl: { control: "text", table: { category: "Image" } },
    initials: { control: "text", table: { category: "Identity" } },
    ariaLabel: { control: "text", table: { category: "Accessibility" } },
    decorative: { control: "boolean", table: { category: "Accessibility" } },
    imageAlt: { control: "text", table: { category: "Accessibility" } },
    className: { control: false, table: { category: "Appearance" } },
    imageClassName: { control: false, table: { category: "Appearance" } },
    fallbackClassName: { control: false, table: { category: "Appearance" } },
    role: { control: false, table: { category: "Accessibility" } },
  },
} satisfies Meta<typeof PersonAvatar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The placeholder: the name's first letter on the shared avatar colours. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("img")).toHaveTextContent(
      ONLY_A
    );
  },
};

/** The photo; the letter underneath shows only if it fails. */
export const Photo: Story = { args: { avatarUrl: PHOTO_URL } };

/** A photo that fails to load falls back to the letter. */
export const FailedPhoto: Story = { args: { avatarUrl: FAILED_PHOTO_URL } };

/** Online: the dot sits bottom right, sized to the avatar. */
export const Online: Story = { args: { online: true } };

/** A record's own two-letter initials still draw one letter. */
export const OneInitial: Story = {
  args: { initials: "AC" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("img")).toHaveTextContent(
      ONLY_A
    );
  },
};

/** Every size side by side, as the Figma frame lays them out. */
export const AllSizes: Story = {
  render: (args) => (
    <div className="flex flex-col gap-8">
      {[
        { avatarUrl: PHOTO_URL, online: false },
        { avatarUrl: PHOTO_URL, online: true },
        { avatarUrl: undefined, online: false },
        { avatarUrl: undefined, online: true },
      ].map((row) => (
        <div
          className="flex items-end gap-6"
          key={`${row.avatarUrl ? "photo" : "letter"}-${row.online}`}
        >
          {SIZES.map((size) => (
            <PersonAvatar {...args} {...row} key={size} size={size} />
          ))}
        </div>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const avatars = within(canvasElement).getAllByRole("img");
    await expect(avatars).toHaveLength(SIZES.length * 4);
    // The circle follows the size: 16px (size-4) for 2xs up to 64px
    // (size-16) for 2xl. Classes, not measurements: the jsdom sweep has no
    // layout.
    await expect(avatars[0]).toHaveClass("size-4");
    await expect(avatars[SIZES.length - 1]).toHaveClass("size-16");
  },
};

/** Beside a person's name and email, as Figma's examples show it. */
export const InPersonRow: Story = {
  args: { ariaLabel: undefined, decorative: true, role: undefined },
  render: (args) => (
    <div className="flex flex-col gap-4">
      {(["sm", "md", "lg", "xl"] as const).map((size) => (
        <div className="flex items-center gap-3" key={size}>
          <PersonAvatar {...args} size={size} />
          <div className="leading-tight">
            <p className="font-medium text-sm">{args.name}</p>
            <p className="text-muted-foreground text-xs">avery@example.com</p>
          </div>
        </div>
      ))}
    </div>
  ),
};

/** Every size in dark: Zinc/700 behind a Zinc/50 letter, a Green/800 dot. */
export const Dark: Story = {
  ...AllSizes,
  globals: { theme: "dark" },
};
