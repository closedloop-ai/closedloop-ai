"use client"

import * as React from "react"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"
import { type VariantProps } from "class-variance-authority"

import { cn } from "@closedloop-ai/design-system/lib/utils"
import { toggleVariants } from "@closedloop-ai/design-system/components/ui/toggle"

const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants> & {
    spacing?: number
  }
>({
  size: "default",
  variant: "default",
  spacing: 0,
})

function ToggleGroup({
  className,
  variant,
  size,
  spacing = 0,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof toggleVariants> & {
    spacing?: number
  }) {
  const contextValue = React.useMemo(
    () => ({ variant, size, spacing }),
    [variant, size, spacing]
  )
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      style={{ "--gap": spacing } as React.CSSProperties}
      className={cn(
        // outline = shadcn-style segmented control: a bordered, padded container
        // that holds borderless pill items (see ToggleGroupItem).
        "group/toggle-group flex w-fit items-center gap-[--spacing(var(--gap))] rounded-md data-[variant=outline]:border data-[variant=outline]:border-border data-[variant=outline]:bg-background data-[variant=outline]:p-0.5",
        className
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={contextValue}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  )
}

function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> &
  VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext)

  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={context.variant || variant}
      data-size={context.size || size}
      data-spacing={context.spacing}
      className={cn(
        toggleVariants({
          variant: context.variant || variant,
          size: context.size || size,
        }),
        "w-auto min-w-0 shrink-0 px-3 focus:z-10 focus-visible:z-10",
        // outline = shadcn-style segmented control: borderless pills sitting in a
        // bordered, padded container; the active pill is filled with the accent
        // color and inactive labels are muted (28px tall to fit the 34px frame).
        "data-[variant=outline]:h-7 data-[variant=outline]:rounded-sm data-[variant=outline]:border-0 data-[variant=outline]:bg-transparent data-[variant=outline]:text-xs data-[variant=outline]:font-medium data-[variant=outline]:text-muted-foreground data-[variant=outline]:shadow-none data-[variant=outline]:hover:bg-transparent data-[variant=outline]:hover:text-foreground data-[variant=outline]:data-[state=on]:bg-muted data-[variant=outline]:data-[state=on]:text-accent-foreground",
        className
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  )
}

export { ToggleGroup, ToggleGroupItem }
