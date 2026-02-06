"use client"

import * as React from "react"
import { Star } from "lucide-react"

import { cn } from "@repo/design-system/lib/utils"

interface StarRatingProps {
  value: number
  onChange?: (value: number) => void
  size?: "sm" | "default" | "lg"
  readonly?: boolean
}

const sizeMap = {
  sm: "h-4 w-4",
  default: "h-5 w-5",
  lg: "h-6 w-6",
} as const

function StarRating({
  value,
  onChange,
  size = "default",
  readonly = false,
}: StarRatingProps) {
  // Clamp value to 0-5 range
  const clampedValue = Math.max(0, Math.min(5, value))

  const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null)
  const [focusedIndex, setFocusedIndex] = React.useState<number | null>(null)

  const isInteractive = Boolean(onChange && !readonly)

  const handleStarClick = (index: number) => {
    if (isInteractive && onChange) {
      onChange(index)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!isInteractive || !onChange) return

    const currentIndex = focusedIndex ?? clampedValue

    switch (event.key) {
      case "ArrowLeft": {
        event.preventDefault()
        const newValue = Math.max(0, currentIndex - 1)
        setFocusedIndex(newValue)
        onChange(newValue)
        break
      }
      case "ArrowRight": {
        event.preventDefault()
        const newValue = Math.min(5, currentIndex + 1)
        setFocusedIndex(newValue)
        onChange(newValue)
        break
      }
      case "Enter":
      case " ": {
        event.preventDefault()
        if (focusedIndex !== null) {
          onChange(focusedIndex)
        }
        break
      }
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Rate 1 to 5 stars"
      tabIndex={isInteractive ? 0 : -1}
      className={cn(
        "inline-flex items-center gap-1",
        isInteractive &&
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      )}
      onKeyDown={handleKeyDown}
      onMouseLeave={() => setHoveredIndex(null)}
    >
      {[1, 2, 3, 4, 5].map((index) => {
        const isFilled = index <= clampedValue
        const isHovered = hoveredIndex !== null && index <= hoveredIndex
        const showHoverPreview = isHovered && isInteractive

        return (
          <Star
            key={index}
            role="radio"
            aria-checked={isFilled}
            className={cn(
              sizeMap[size],
              "transition-all",
              isFilled ? "fill-yellow-500 text-yellow-500" : "text-muted-foreground",
              showHoverPreview && "opacity-70",
              isInteractive ? "cursor-pointer" : "cursor-default"
            )}
            onClick={() => handleStarClick(index)}
            onMouseEnter={() => isInteractive && setHoveredIndex(index)}
          />
        )
      })}
    </div>
  )
}

export { StarRating }
