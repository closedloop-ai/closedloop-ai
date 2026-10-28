"use client";

import { createResizableLayoutStorage } from "@closedloop-ai/design-system/components/ui/resizable-layout-storage";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { GripVerticalIcon } from "lucide-react";
import * as React from "react";
import {
  Group,
  type GroupProps,
  type Layout,
  type LayoutChangedMeta,
  type Orientation,
  Panel,
  type PanelProps,
  Separator,
  type SeparatorProps,
  useDefaultLayout,
} from "react-resizable-panels";

/**
 * react-resizable-panels@4 renamed `PanelGroup` to `Group` and
 * `PanelResizeHandle` to `Separator`, replaced `direction` with `orientation`,
 * dropped `autoSaveId` in favour of the `useDefaultLayout` hook, and — the
 * change with no compile error behind it — reinterpreted NUMERIC size props as
 * PIXELS where v3 read them as percentages.
 *
 * This wrapper keeps the v3-shaped public API (`direction`, `autoSaveId`,
 * numeric percentage sizes) so the surfaces that consume it do not each have to
 * carry the migration, and so an existing user's saved panel layout still
 * loads. Strings pass through to v4 untouched, so an explicit unit ("240px",
 * "50%", "20rem") remains available.
 */
const ResizableOrientationContext =
  React.createContext<Orientation>("horizontal");

type ResizablePanelGroupProps = Omit<GroupProps, "orientation"> & {
  /** v3-compatible alias for v4's `orientation`. */
  direction?: Orientation;
  /** Persists this group's layout, under the key v3 used. Needs `panelIds`. */
  autoSaveId?: string;
  /**
   * Ids of this group's `ResizablePanel`s, in render order. Required alongside
   * `autoSaveId`: v4 keys a persisted layout by panel id, so a panel that lets
   * its id default to `useId()` cannot have its size restored at all.
   */
  panelIds?: readonly string[];
};

function BaseResizablePanelGroup({
  className,
  direction,
  ...props
}: Omit<GroupProps, "orientation"> & { direction: Orientation }) {
  return (
    <ResizableOrientationContext.Provider value={direction}>
      <Group
        className={cn(
          "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
          className
        )}
        // v3 emitted this attribute itself and the styles here key off it; v4
        // emits only `data-group`, so the wrapper restates the orientation.
        data-panel-group-direction={direction}
        data-slot="resizable-panel-group"
        orientation={direction}
        {...props}
      />
    </ResizableOrientationContext.Provider>
  );
}

function PersistedResizablePanelGroup({
  autoSaveId,
  onLayoutChanged,
  panelIds,
  ...props
}: Omit<GroupProps, "orientation"> & {
  autoSaveId: string;
  direction: Orientation;
  panelIds: readonly string[];
}) {
  const panelIdKey = panelIds.join(",");
  const ids = React.useMemo(() => panelIdKey.split(","), [panelIdKey]);
  const storage = React.useMemo(
    () => createResizableLayoutStorage(autoSaveId, ids),
    [autoSaveId, ids]
  );
  const { defaultLayout, onLayoutChanged: persistLayout } = useDefaultLayout({
    id: autoSaveId,
    panelIds: ids,
    storage,
  });
  const handleLayoutChanged = React.useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      persistLayout(layout, meta);
      onLayoutChanged?.(layout, meta);
    },
    [onLayoutChanged, persistLayout]
  );

  return (
    <BaseResizablePanelGroup
      defaultLayout={defaultLayout}
      onLayoutChanged={handleLayoutChanged}
      {...props}
    />
  );
}

function ResizablePanelGroup({
  autoSaveId,
  direction = "horizontal",
  panelIds,
  ...props
}: ResizablePanelGroupProps) {
  if (autoSaveId && panelIds && panelIds.length > 0) {
    return (
      <PersistedResizablePanelGroup
        autoSaveId={autoSaveId}
        direction={direction}
        panelIds={panelIds}
        {...props}
      />
    );
  }
  return <BaseResizablePanelGroup direction={direction} {...props} />;
}

/**
 * v3 read a bare number as a percentage of the group; v4 reads it as pixels and
 * a unitless STRING as a percentage. Numbers keep their v3 meaning here so
 * every existing call site stays correct.
 */
function asPercentageSize(
  size: number | string | undefined
): number | string | undefined {
  return typeof size === "number" ? `${size}%` : size;
}

function ResizablePanel({
  collapsedSize,
  defaultSize,
  maxSize,
  minSize,
  ...props
}: PanelProps) {
  return (
    <Panel
      collapsedSize={asPercentageSize(collapsedSize)}
      data-slot="resizable-panel"
      defaultSize={asPercentageSize(defaultSize)}
      maxSize={asPercentageSize(maxSize)}
      minSize={asPercentageSize(minSize)}
      {...props}
    />
  );
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: SeparatorProps & {
  withHandle?: boolean;
}) {
  const direction = React.useContext(ResizableOrientationContext);
  return (
    <Separator
      className={cn(
        "bg-border focus-visible:ring-ring relative flex w-px items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-1 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:translate-x-0 data-[panel-group-direction=vertical]:after:-translate-y-1/2 [&[data-panel-group-direction=vertical]>div]:rotate-90",
        className
      )}
      data-panel-group-direction={direction}
      data-slot="resizable-handle"
      {...props}
    >
      {withHandle ? (
        <div className="bg-border z-10 flex h-4 w-3 items-center justify-center rounded-xs border">
          <GripVerticalIcon className="size-2.5" />
        </div>
      ) : null}
    </Separator>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
