"use client";

import { cn } from "@closedloop-ai/design-system/lib/utils";
import { Slot as SlotPrimitive } from "radix-ui";
import {
  createContext,
  type ComponentProps,
  type ReactNode,
  useContext,
} from "react";
import {
  GridInteractionState,
  type GridInteractionState as GridInteractionStateValue,
} from "../../lib/grid-interaction-contract";

const GridInteractionContractEnabledContext = createContext(false);

const LEGACY_REVEAL_CLASS = {
  inlineName:
    "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/inline-name:opacity-100",
  lead: "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/lead:opacity-100",
  row: "opacity-0 transition-colors focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100",
  rowGroup:
    "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100 touch:opacity-100",
} as const;

export type GridContextualActionLegacyReveal = keyof typeof LEGACY_REVEAL_CLASS;

/**
 * Applies the mastered pointer, cursor, hover, and transient-state grammar to
 * any domain-free grid composition nested beneath it.
 */
export function GridInteractionContract({
  children,
  className,
  enabled = true,
  state,
}: {
  children: ReactNode;
  className?: string;
  enabled?: boolean;
  state?: GridInteractionStateValue;
}) {
  return (
    <GridInteractionContractEnabledContext.Provider value={enabled}>
      <div
        aria-busy={
          enabled && state === GridInteractionState.Loading ? true : undefined
        }
        className={cn("contents", className)}
        data-grid-interaction-contract={enabled ? "pointer-hover" : undefined}
        data-interaction-state={enabled ? state : undefined}
      >
        {children}
      </div>
    </GridInteractionContractEnabledContext.Provider>
  );
}

/** Reports whether a descendant is inside an enabled interaction contract. */
export function useGridInteractionContractEnabled(): boolean {
  return useContext(GridInteractionContractEnabledContext);
}

export type GridContextualActionProps = ComponentProps<"span"> & {
  asChild?: boolean;
  legacyReveal?: GridContextualActionLegacyReveal;
  open?: boolean;
};

/**
 * Marks an action whose nearest interaction contract owns hover, focus, open,
 * and coarse-pointer reveal behavior. The caller owns the reserved layout slot.
 */
export function GridContextualAction({
  asChild = false,
  className,
  legacyReveal,
  open = false,
  ...props
}: GridContextualActionProps) {
  const contractEnabled = useContext(GridInteractionContractEnabledContext);
  const Component = asChild ? SlotPrimitive.Slot : "span";
  const appliesLegacyReveal = !contractEnabled && legacyReveal !== undefined;
  return (
    <Component
      className={cn(
        appliesLegacyReveal ? LEGACY_REVEAL_CLASS[legacyReveal] : undefined,
        className
      )}
      data-grid-contextual-action=""
      data-grid-contextual-action-legacy={
        appliesLegacyReveal ? legacyReveal : undefined
      }
      data-state={open ? "open" : undefined}
      {...props}
    />
  );
}
