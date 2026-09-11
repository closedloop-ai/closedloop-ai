import { FavoriteButton } from "@repo/design-system/components/ui/favorite-button";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

function FavoriteButtonDemo({
  initialFavorite,
  size,
  isPending = false,
  addLabel,
  removeLabel,
}: {
  initialFavorite: boolean;
  size?: "sm" | "default";
  isPending?: boolean;
  addLabel?: string;
  removeLabel?: string;
}) {
  const [isFavorite, setIsFavorite] = useState(initialFavorite);
  const [toggleCount, setToggleCount] = useState(0);

  return (
    <div className="flex items-center gap-3 rounded-lg border p-4">
      <FavoriteButton
        addLabel={addLabel}
        isFavorite={isFavorite}
        isPending={isPending}
        onToggle={(nextIsFavorite) => {
          setIsFavorite(nextIsFavorite);
          setToggleCount((current) => current + 1);
        }}
        removeLabel={removeLabel}
        size={size}
      />
      <div className="space-y-1 text-sm">
        <div className="font-medium">
          {isFavorite ? "Marked as favorite" : "Not favorited"}
        </div>
        <div className="text-muted-foreground">
          Toggle handler fired {toggleCount} times
        </div>
      </div>
    </div>
  );
}

/**
 * A star icon button that toggles whether something is marked as a favorite.
 * The star fills in yellow when the item is favorited, and a tooltip
 * explains what clicking it will do next, such as Add to favorites or Remove
 * from favorites. It does not track its own state, so the screen that uses
 * it has to hold the current favorited value and handle the toggle, and it
 * can be disabled while a save is in flight.
 */
const meta = {
  title: "Composites/Actions/Favorite Button",
  component: FavoriteButtonDemo,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  argTypes: {
    initialFavorite: {
      control: "boolean",
      description: "Favorite state the demo wrapper starts in.",
    },
    size: {
      options: ["sm", "default"],
      control: { type: "radio" },
    },
    isPending: {
      control: "boolean",
      description: "Disables the button while a toggle is in flight.",
    },
    addLabel: { control: "text" },
    removeLabel: { control: "text" },
  },
  args: {
    initialFavorite: false,
    size: "sm",
    isPending: false,
    addLabel: "Add to favorites",
    removeLabel: "Remove from favorites",
  },
} satisfies Meta<typeof FavoriteButtonDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Active: Story = {
  args: {
    initialFavorite: true,
  },
};

export const Pending: Story = {
  args: {
    initialFavorite: true,
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
