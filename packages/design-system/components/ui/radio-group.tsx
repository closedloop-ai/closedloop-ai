"use client"

import * as React from "react"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"
import { CircleIcon } from "lucide-react"

import { cn } from "@closedloop-ai/design-system/lib/utils"
import { INVALID_STATE_UTILITIES } from "./invalid-state"

/**
 * `segmented` draws the group as the outline segmented control `ToggleGroup`
 * ships (a bordered, padded track of borderless pills), but keeps radio
 * semantics: arrow keys move the selection, not only focus. Each item renders
 * its children as the visible label, which is also its accessible name.
 */
type RadioGroupVariant = "default" | "segmented"

const RadioGroupVariantContext =
  React.createContext<RadioGroupVariant>("default")

function RadioGroup({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root> & {
  variant?: RadioGroupVariant
}) {
  return (
    <RadioGroupVariantContext.Provider value={variant}>
      <RadioGroupPrimitive.Root
        data-slot="radio-group"
        data-variant={variant}
        className={cn(
          variant === "segmented"
            ? "flex w-fit items-center rounded-md border border-border bg-background p-0.5"
            : "grid gap-3",
          className
        )}
        {...props}
      />
    </RadioGroupVariantContext.Provider>
  )
}

function RadioGroupItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  const variant = React.useContext(RadioGroupVariantContext)

  if (variant === "segmented") {
    return (
      <RadioGroupPrimitive.Item
        data-slot="radio-group-item"
        data-variant={variant}
        className={cn(
          "inline-flex h-7 shrink-0 items-center justify-center whitespace-nowrap rounded-sm px-3 font-medium text-muted-foreground text-xs outline-none transition-[color,box-shadow] hover:text-foreground focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-muted data-[state=checked]:text-accent-foreground",
          className
        )}
        {...props}
      >
        {children}
      </RadioGroupPrimitive.Item>
    )
  }

  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        `border-input-border text-primary focus-visible:border-ring focus-visible:ring-ring ${INVALID_STATE_UTILITIES} bg-input dark:bg-input aspect-square size-4 shrink-0 rounded-full border shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50`,
        className
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex items-center justify-center"
      >
        <CircleIcon className="fill-primary absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  )
}

export { RadioGroup, RadioGroupItem }
