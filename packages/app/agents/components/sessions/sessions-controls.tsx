"use client";

import type { SessionControls } from "@repo/app/agents/lib/session-types";
import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@repo/design-system/components/ui/pagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import type { PaginationState } from "@repo/design-system/components/ui/types";
import { cn } from "@repo/design-system/lib/utils";
import {
  ArrowDown,
  ArrowUp,
  RefreshCw,
  Search,
  Wifi,
  WifiOff,
} from "lucide-react";

type SessionsControlsProps = {
  controls: SessionControls;
  pagination: PaginationState;
  onSearchValueChange?: (value: string) => void;
  onDirectoryValueChange?: (value: string) => void;
  onSortValueChange?: (value: string) => void;
  onSortDirectionChange?: (descending: boolean) => void;
  onRefresh?: () => void;
  onHarnessValueChange?: (value: string) => void;
  onStatusValueChange?: (value: string) => void;
  onPageChange?: (page: number) => void;
};

function FilterPillGroup({
  options,
  value,
  disabled,
  onValueChange,
}: {
  options: SessionControls["harnessOptions"];
  value?: string;
  disabled: boolean;
  onValueChange?: (value: string) => void;
}) {
  return (
    <div className="flex min-w-max gap-1 rounded-lg border border-border bg-background p-1">
      {options.map((option) => {
        const selected = (value || "") === option.value;

        return (
          <Button
            className="h-8 rounded-md px-3 text-xs"
            disabled={disabled}
            key={option.value || "__all__"}
            onClick={() => onValueChange?.(option.value)}
            variant={selected ? "secondary" : "ghost"}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: large presentational controls layout migrated as-is from @repo/design-system in PR A2.
export function SessionsControls({
  controls,
  pagination,
  onSearchValueChange,
  onDirectoryValueChange,
  onSortValueChange,
  onSortDirectionChange,
  onRefresh,
  onHarnessValueChange,
  onStatusValueChange,
  onPageChange,
}: SessionsControlsProps) {
  const showingFrom =
    pagination.total === 0 ? 0 : pagination.page * pagination.pageSize + 1;
  const showingTo = Math.min(
    (pagination.page + 1) * pagination.pageSize,
    pagination.total
  );
  const searchDisabled = !onSearchValueChange;
  const directoryDisabled = !onDirectoryValueChange;
  const sortValueDisabled = !onSortValueChange;
  const harnessDisabled = !onHarnessValueChange;
  const statusDisabled = !onStatusValueChange;
  const pageNavigationDisabled = !onPageChange;
  const previousDisabled = pageNavigationDisabled || pagination.page === 0;
  const nextDisabled =
    pageNavigationDisabled || pagination.page >= pagination.totalPages - 1;
  const disabledPaginationClassName = "pointer-events-none opacity-50";
  const hasHeader = controls.title || controls.countLabel;
  const sessionCountLabel =
    controls.countLabel || `${pagination.total.toLocaleString()} sessions`;

  return (
    <div className="space-y-4 rounded-2xl border border-border bg-card/80 p-4 shadow-sm">
      {hasHeader ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            {controls.title ? (
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-foreground text-lg">
                  {controls.title}
                </h3>
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium text-[11px]",
                    controls.isLive
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                      : "border-border bg-muted/40 text-muted-foreground"
                  )}
                >
                  {controls.isLive ? (
                    <Wifi className="size-3.5" />
                  ) : (
                    <WifiOff className="size-3.5" />
                  )}
                  {controls.isLive
                    ? controls.liveLabel || "Live"
                    : controls.offlineLabel || "Offline"}
                </span>
              </div>
            ) : null}
            <p className="text-muted-foreground text-sm">{sessionCountLabel}</p>
          </div>

          <Button
            className="shrink-0"
            disabled={!onRefresh}
            onClick={onRefresh}
            variant="outline"
          >
            <RefreshCw className="size-4" />
            {controls.refreshLabel || "Refresh"}
          </Button>
        </div>
      ) : null}

      <div className="rounded-xl border border-border/70 bg-background/70 p-2">
        <div className="flex flex-wrap items-center gap-3 lg:flex-nowrap">
          <div className="relative min-w-[18rem] flex-1">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search sessions"
              className="pl-9"
              disabled={searchDisabled}
              onChange={(event) => onSearchValueChange?.(event.target.value)}
              placeholder={controls.searchPlaceholder}
              readOnly={searchDisabled}
              value={controls.searchValue || ""}
            />
          </div>

          <Select
            disabled={directoryDisabled}
            onValueChange={(value) =>
              onDirectoryValueChange?.(value === "__all__" ? "" : value)
            }
            value={controls.directoryValue || "__all__"}
          >
            <SelectTrigger className="min-w-[13rem] lg:w-[15rem]">
              <SelectValue placeholder="Directory" />
            </SelectTrigger>
            <SelectContent>
              {controls.directoryOptions.map((option) => (
                <SelectItem
                  key={option.value || "__all__"}
                  value={option.value || "__all__"}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex min-w-[16rem] flex-1 items-center gap-2 rounded-lg border border-border bg-background px-2 py-1.5">
            <Select
              disabled={sortValueDisabled}
              onValueChange={onSortValueChange}
              value={controls.sortValue || "time"}
            >
              <SelectTrigger className="h-auto flex-1 border-0 bg-transparent px-1 py-0 shadow-none focus:ring-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {controls.sortOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="h-4 w-px bg-border" />
            <Button
              aria-label={
                controls.sortDescending ? "Sort ascending" : "Sort descending"
              }
              className="shrink-0"
              disabled={!onSortDirectionChange}
              onClick={() => onSortDirectionChange?.(!controls.sortDescending)}
              size="icon"
              variant="ghost"
            >
              {controls.sortDescending ? (
                <ArrowDown className="size-4" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-3 overflow-x-auto pb-1 xl:flex-row xl:items-center">
          <FilterPillGroup
            disabled={harnessDisabled}
            onValueChange={onHarnessValueChange}
            options={controls.harnessOptions}
            value={controls.harnessValue}
          />

          <FilterPillGroup
            disabled={statusDisabled}
            onValueChange={onStatusValueChange}
            options={controls.statusOptions}
            value={controls.statusValue}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3 border-border/70 border-t pt-4 lg:flex-row lg:items-center lg:justify-between">
        <Chip variant="muted">
          Showing {showingFrom}-{showingTo} of {pagination.total}
        </Chip>

        <Pagination className="mx-0 w-auto justify-start lg:justify-end">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                aria-disabled={previousDisabled}
                className={
                  previousDisabled ? disabledPaginationClassName : undefined
                }
                href="#"
                onClick={(event) => {
                  event.preventDefault();
                  if (pagination.page > 0) {
                    onPageChange?.(pagination.page - 1);
                  }
                }}
                tabIndex={previousDisabled ? -1 : undefined}
              />
            </PaginationItem>
            {Array.from(
              { length: Math.min(pagination.totalPages, 5) },
              (_, index) => {
                const pageNumber = index + 1;
                return (
                  <PaginationItem key={`sessions-page-${pageNumber}`}>
                    <PaginationLink
                      aria-disabled={pageNavigationDisabled}
                      className={
                        pageNavigationDisabled
                          ? disabledPaginationClassName
                          : undefined
                      }
                      href="#"
                      isActive={index === pagination.page}
                      onClick={(event) => {
                        event.preventDefault();
                        onPageChange?.(index);
                      }}
                      tabIndex={pageNavigationDisabled ? -1 : undefined}
                    >
                      {pageNumber}
                    </PaginationLink>
                  </PaginationItem>
                );
              }
            )}
            <PaginationItem>
              <PaginationNext
                aria-disabled={nextDisabled}
                className={
                  nextDisabled ? disabledPaginationClassName : undefined
                }
                href="#"
                onClick={(event) => {
                  event.preventDefault();
                  if (pagination.page < pagination.totalPages - 1) {
                    onPageChange?.(pagination.page + 1);
                  }
                }}
                tabIndex={nextDisabled ? -1 : undefined}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  );
}
