"use client";

import { cn } from "@closedloop-ai/design-system/lib/utils";
import { Star } from "lucide-react";
import { type KeyboardEvent, useState } from "react";

type StarRatingProps = {
  value: number;
  onChange?: (value: number) => void;
  size?: "sm" | "default" | "lg";
  readonly?: boolean;
};

const sizeMap = {
  sm: "h-4 w-4",
  default: "h-5 w-5",
  lg: "h-6 w-6",
} as const;

export function StarRating({
  value,
  onChange,
  size = "default",
  readonly = false,
}: StarRatingProps) {
  const clampedValue = Math.max(0, Math.min(5, value));

  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  const isInteractive = Boolean(onChange && !readonly);

  const handleStarClick = (index: number) => {
    if (isInteractive && onChange) {
      onChange(index);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(isInteractive && onChange)) {
      return;
    }

    const currentIndex = focusedIndex ?? clampedValue;

    switch (event.key) {
      case "ArrowLeft": {
        event.preventDefault();
        const newValue = Math.max(0, currentIndex - 1);
        setFocusedIndex(newValue);
        onChange(newValue);
        break;
      }
      case "ArrowRight": {
        event.preventDefault();
        const newValue = Math.min(5, currentIndex + 1);
        setFocusedIndex(newValue);
        onChange(newValue);
        break;
      }
      case "Enter":
      case " ": {
        event.preventDefault();
        if (focusedIndex !== null) {
          onChange(focusedIndex);
        }
        break;
      }
      default:
        break;
    }
  };

  return (
    <div
      aria-label="Rate 1 to 5 stars"
      className={cn(
        "inline-flex items-center gap-1",
        isInteractive &&
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      )}
      onKeyDown={handleKeyDown}
      onMouseLeave={() => setHoveredIndex(null)}
      role="radiogroup"
      tabIndex={isInteractive ? 0 : -1}
    >
      {[1, 2, 3, 4, 5].map((index) => {
        const isFilled = index <= clampedValue;
        const isHovered = hoveredIndex !== null && index <= hoveredIndex;
        const showHoverPreview = isHovered && isInteractive;

        return (
          <Star
            aria-checked={isFilled}
            className={cn(
              sizeMap[size],
              "transition-all",
              isFilled
                ? "fill-yellow-500 text-yellow-500"
                : "text-muted-foreground",
              showHoverPreview && "opacity-70",
              isInteractive ? "cursor-pointer" : "cursor-default"
            )}
            key={index}
            onClick={() => handleStarClick(index)}
            onMouseEnter={() => isInteractive && setHoveredIndex(index)}
            role="radio"
          />
        );
      })}
    </div>
  );
}
