"use client";

import { TabsList, TabsTrigger } from "@repo/design-system/components/ui/tabs";
import { cn } from "@repo/design-system/lib/utils";
import type { ComponentProps } from "react";

export function UnderlineTabsList({
  className,
  ...props
}: ComponentProps<typeof TabsList>) {
  return (
    <TabsList
      className={cn(
        "h-auto w-full justify-start gap-0 rounded-none border-border border-b bg-transparent p-0 px-4 pt-2",
        className
      )}
      {...props}
    />
  );
}

export function UnderlineTabsTrigger({
  className,
  ...props
}: ComponentProps<typeof TabsTrigger>) {
  return (
    <TabsTrigger
      className={cn(
        "h-auto flex-none rounded-none border-0 border-transparent border-b-2 bg-transparent px-3 py-1.5 text-base text-muted-foreground shadow-none data-[state=active]:border-b-indigo-500 data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none",
        className
      )}
      {...props}
    />
  );
}
