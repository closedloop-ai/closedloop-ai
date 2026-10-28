import * as React from "react"
import { Slot as SlotPrimitive } from "radix-ui"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@closedloop-ai/design-system/lib/utils"
import { INVALID_STATE_UTILITIES } from "./invalid-state"

const buttonVariants = cva(
  `inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-[3px] ${INVALID_STATE_UTILITIES}`,
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        outline:
          "border border-input-border bg-input hover:bg-muted hover:text-foreground dark:bg-input dark:hover:bg-muted",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-muted hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        // The same affordance as `link` in the foreground tone, for an
        // inline link inside running text that should read as part of the
        // sentence rather than as a brand-colored call to action — e.g. the
        // "Sign up" prompt on the Login surface, next to plain body copy.
        linkForeground: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-9 px-4 gap-2 py-2 has-[>svg]:px-3 [&_svg:not([class*='size-'])]:size-4",
        sm: "h-8 rounded-md gap-2 px-3 has-[>svg]:px-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 rounded-md gap-2 px-6 has-[>svg]:px-4 [&_svg:not([class*='size-'])]:size-4",
        icon: "size-9 [&_svg:not([class*='size-'])]:size-4",
        "icon-sm": "size-8 [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /**
     * Render as the child element instead of a `<button>`, keeping this
     * component's styling. Use to make a link (e.g. `<a>` or a routed
     * `Link`) look like a button, rather than nesting a real button
     * inside an anchor.
     */
    asChild?: boolean
  }

/**
 * Triggers an in-page action: submitting a form, running a command, or
 * confirming/canceling a dialog. For navigation to another route, pair
 * `asChild` with a real link rather than relying on the `link` variant
 * alone.
 *
 * @summary triggers an in-page action; use `asChild` to render as a link
 */
function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? SlotPrimitive.Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
