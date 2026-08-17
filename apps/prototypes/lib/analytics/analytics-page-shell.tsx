"use client";

import { AnalyticsRangeToggle } from "@repo/design-system/components/ui/analytics-range-toggle";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import type { ReactNode } from "react";
import { DATA_STATE_LABELS, DATA_STATE_ORDER, type DataState } from "./format";

/**
 * The page frame both analytics prototypes share, so the two read as one
 * product rather than two dashboards. The header rhythm is lifted from the
 * production Insights surface (`packages/app/insights/components/insights-page.tsx`):
 * a slim bordered bar carrying the title, a one-line subtitle, and the scope /
 * range controls on the right.
 */

export const RANGE_OPTIONS = [
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "90d", value: "90d" },
];

export const SCOPE_OPTIONS = [
  { label: "Whole org", value: "org" },
  { label: "Platform team", value: "platform" },
  { label: "Product team", value: "product" },
];

type AnalyticsPageShellProps = {
  readonly title: string;
  readonly subtitle: string;
  readonly range: string;
  readonly onRangeChange: (value: string) => void;
  readonly scope: string;
  readonly onScopeChange: (value: string) => void;
  readonly dataState: DataState;
  readonly onDataStateChange: (value: DataState) => void;
  readonly children: ReactNode;
};

export function AnalyticsPageShell({
  title,
  subtitle,
  range,
  onRangeChange,
  scope,
  onScopeChange,
  dataState,
  onDataStateChange,
  children,
}: AnalyticsPageShellProps) {
  return (
    <main className="min-h-svh bg-background">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h1 className="font-medium text-sm">{title}</h1>
          <p className="truncate text-muted-foreground text-xs">{subtitle}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Select onValueChange={onScopeChange} value={scope}>
            <SelectTrigger aria-label="Scope" className="h-8 w-40" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCOPE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <AnalyticsRangeToggle
            onValueChange={onRangeChange}
            options={RANGE_OPTIONS}
            value={range}
          />
          {/* Prototype-only control. It exists so a reviewer can see the three
              data states this screen has to keep apart (skeleton / settled-
              unavailable / real zero) without waiting for a slow read. It does
              not ship: production drives these from the query state. */}
          <span className="ml-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
            Preview
          </span>
          <Select
            onValueChange={(value) => onDataStateChange(value as DataState)}
            value={dataState}
          >
            <SelectTrigger
              aria-label="Preview data state"
              className="h-8 w-44"
              size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATA_STATE_ORDER.map((option) => (
                <SelectItem key={option} value={option}>
                  {DATA_STATE_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">
        {children}
      </div>
    </main>
  );
}
