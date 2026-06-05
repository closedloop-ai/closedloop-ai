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
    <div className="flex h-12 items-center gap-6 border-b py-2">
      <span className="min-w-0 flex-1 font-semibold text-lg">{title}</span>
      {children ? (
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}
