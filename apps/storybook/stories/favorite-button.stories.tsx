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

const meta = {
  title: "Design System/Primitives/Favorite Button",
  component: FavoriteButtonDemo,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  args: {
    initialFavorite: false,
    size: "sm",
    isPending: false,
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
