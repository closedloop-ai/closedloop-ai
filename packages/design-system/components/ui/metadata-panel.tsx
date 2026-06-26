"use client";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { cn } from "@repo/design-system/lib/utils";

type MetadataPanelProps = {
  title?: string;
  children: React.ReactNode;
  className?: string;
  variant?: "bar" | "sidebar";
};

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
      {title ? <h3 className="mb-4 font-semibold">{title}</h3> : null}
      <div className="space-y-4">{children}</div>
    </div>
  );
}

type MetadataSectionProps = {
  children: React.ReactNode;
  separator?: boolean;
  className?: string;
  layout?: "horizontal" | "vertical";
};

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
        layout === "vertical" && separator ? "border-t pt-4" : null,
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
