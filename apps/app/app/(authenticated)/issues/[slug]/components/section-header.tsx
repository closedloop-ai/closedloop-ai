"use client";

import type { ReactNode } from "react";

type SectionHeaderProps = {
  title: string;
  children?: ReactNode;
};

export function SectionHeader({
  title,
  children,
}: Readonly<SectionHeaderProps>) {
  return (
    <div className="flex items-center gap-6 border-b px-4 py-2">
      <span className="min-w-0 flex-1 font-medium text-base">{title}</span>
      {children ? (
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}
