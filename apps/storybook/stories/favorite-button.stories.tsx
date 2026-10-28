import { FavoriteButton } from "@repo/design-system/components/ui/favorite-button";
import { remountKey } from "@repo/design-system/storybook/remount-key";
import type { Meta, StoryObj } from "@storybook/react";
import type { ComponentProps } from "react";
import { useState } from "react";

function FavoriteButtonStory({
  isFavorite,
  ...args
}: ComponentProps<typeof FavoriteButton>) {
  const [currentIsFavorite, setIsFavorite] = useState(isFavorite);
  return (
    <FavoriteButton
      {...args}
      isFavorite={currentIsFavorite}
      onToggle={setIsFavorite}
    />
  );
}

const meta = {
  title: "Primitives v1.0/Actions/Favorite Button",
  component: FavoriteButton,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "centered",
  },
  args: {
    isFavorite: false,
    size: "sm",
    isPending: false,
  },
  // key remounts the story when the Controls panel changes `isFavorite`,
  // re-seeding local state — plain React state, not a Storybook preview
  // hook, so it works in every rendering context (Canvas AND the autodocs
  // inline Docs page, where `useArgs()` previously threw at runtime).
  render: (args) => (
    <FavoriteButtonStory key={remountKey(args.isFavorite)} {...args} />
  ),
} satisfies Meta<typeof FavoriteButton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Active: Story = {
  args: {
    isFavorite: true,
  },
};

export const Pending: Story = {
  args: {
    isFavorite: true,
    isPending: true,
  },
};

export const DefaultSize: Story = {
  args: {
    size: "default",
  },
};

export const CustomLabels: Story = {
  args: {
    addLabel: "Pin artifact",
    removeLabel: "Unpin artifact",
  },
};
