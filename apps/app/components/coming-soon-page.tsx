"use client";

import type { LucideIcon } from "lucide-react";
import { Header } from "@/app/(authenticated)/components/header";

type ComingSoonPageProps = {
  readonly label: string;
  readonly icon: LucideIcon;
};

export function ComingSoonPage({ label, icon: Icon }: ComingSoonPageProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label }]} />
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
        <Icon className="h-12 w-12 text-muted-foreground" />
        <h1 className="font-semibold text-xl">{label}</h1>
        <p className="text-muted-foreground">Coming soon</p>
      </div>
    </div>
  );
}
