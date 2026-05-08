"use client";

export function SidebarCountBadge({ count }: { count: number }) {
  return (
    <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-primary font-medium text-[10px] text-primary-foreground">
      {count}
    </span>
  );
}
