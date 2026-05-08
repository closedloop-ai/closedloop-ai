"use client";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { cn } from "@repo/design-system/lib/utils";

type MetadataPanelProps = {
  /**
   * Optional title to display at the top of the panel (sidebar only)
   */
  title?: string;
  /**
   * Main metadata content (status, approver, artifact-specific fields)
   */
  children: React.ReactNode;
  /**
   * Optional className for custom styling
   */
  className?: string;
  /**
   * Layout variant: "sidebar" = right gutter (w-80 border-l), "bar" = horizontal strip below title
   */
  variant?: "bar" | "sidebar";
};

/**
 * Base metadata panel component for artifact editors.
 * Provides consistent structure with slots for artifact-specific content.
 * Use variant="bar" for horizontal metadata bar below artifact title; default "sidebar" for right gutter.
 *
 * Usage:
 * ```tsx
 * <MetadataPanel title="PRD Details">
 *   <StatusMetadataSection ... />
 * </MetadataPanel>
 * <MetadataPanel variant="bar">
 *   <StatusMetadataSection layout="horizontal" ... />
 * </MetadataPanel>
 * ```
 */
export function MetadataPanel({
  title,
  children,
  className,
  variant = "sidebar",
}: Readonly<MetadataPanelProps>) {
  if (variant === "bar") {
    return (
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 bg-background py-2",
          className
        )}
      >
        {children}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "min-h-0 w-80 overflow-auto border-l bg-background p-4",
        className
      )}
    >
      {title && <h3 className="mb-4 font-semibold">{title}</h3>}
      <div className="space-y-4">{children}</div>
    </div>
  );
}

type MetadataSectionProps = {
  /**
   * Content to display in this section
   */
  children: React.ReactNode;
  /**
   * Whether to show a border-top separator before this section (vertical layout only)
   */
  separator?: boolean;
  /**
   * Optional className for custom styling
   */
  className?: string;
  /**
   * Layout: "vertical" = stacked fields, "horizontal" = single row (for metadata bar)
   */
  layout?: "horizontal" | "vertical";
};

/**
 * Individual section within a metadata panel.
 * Use layout="horizontal" inside MetadataPanel variant="bar" for pill-style row.
 *
 * Usage:
 * ```tsx
 * <MetadataSection separator>
 *   <Label>Field Name</Label>
 *   <Input ... />
 * </MetadataSection>
 * <MetadataSection layout="horizontal">
 *   <StatusSelect ... />
 *   <AssigneePopover ... />
 * </MetadataSection>
 * ```
 */
export function MetadataSection({
  children,
  separator,
  className,
  layout = "vertical",
}: Readonly<MetadataSectionProps>) {
  return (
    <div
      className={cn(
        layout === "horizontal"
          ? "flex flex-wrap items-center gap-2"
          : "space-y-2",
        layout === "vertical" && separator && "border-t pt-4",
        className
      )}
    >
      {children}
    </div>
  );
}

type TabDefinition = {
  id: string;
  label: string;
  content: React.ReactNode;
};

type TabbedMetadataPanelProps = {
  tabs: TabDefinition[];
  className?: string;
  defaultTab?: string;
};

export function TabbedMetadataPanel({
  tabs,
  className,
  defaultTab,
}: Readonly<TabbedMetadataPanelProps>) {
  return (
    <div
      className={cn("w-80 overflow-auto border-l bg-background p-4", className)}
    >
      <Tabs defaultValue={defaultTab ?? tabs[0]?.id}>
        <TabsList className="mb-4 w-full">
          {tabs.map((tab) => (
            <TabsTrigger className="flex-1" key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((tab) => (
          <TabsContent key={tab.id} value={tab.id}>
            {tab.content}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
