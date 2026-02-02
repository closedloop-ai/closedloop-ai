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
   * Title to display at the top of the panel
   */
  title: string;
  /**
   * Main metadata content (status, approver, artifact-specific fields)
   */
  children: React.ReactNode;
  /**
   * Optional className for custom styling
   */
  className?: string;
};

/**
 * Base metadata panel component for artifact editors.
 * Provides consistent structure with slots for artifact-specific content.
 *
 * Usage:
 * ```tsx
 * <MetadataPanel title="PRD Details">
 *   <StatusMetadataSection ... />
 *   <PRDSpecificFields ... />
 *   <ArtifactInfo ... />
 * </MetadataPanel>
 * ```
 */
export function MetadataPanel({
  title,
  children,
  className,
}: Readonly<MetadataPanelProps>) {
  return (
    <div
      className={cn("w-80 overflow-auto border-l bg-muted/30 p-4", className)}
    >
      <h3 className="mb-4 font-semibold">{title}</h3>
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
   * Whether to show a border-top separator before this section
   */
  separator?: boolean;
  /**
   * Optional className for custom styling
   */
  className?: string;
};

/**
 * Individual section within a metadata panel.
 * Used to group related metadata fields with consistent spacing and optional separators.
 *
 * Usage:
 * ```tsx
 * <MetadataSection separator>
 *   <Label>Field Name</Label>
 *   <Input ... />
 * </MetadataSection>
 * ```
 */
export function MetadataSection({
  children,
  separator,
  className,
}: Readonly<MetadataSectionProps>) {
  return (
    <div className={cn("space-y-2", separator && "border-t pt-4", className)}>
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
      className={cn("w-80 overflow-auto border-l bg-muted/30 p-4", className)}
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
