"use client";

import * as React from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";
import { Input } from "./input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { Button } from "./button";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SearchIcon,
} from "lucide-react";
import { cn } from "@repo/design-system/lib/utils";

export type Column<T> = {
  key: keyof T | string;
  header: string;
  sortable?: boolean;
  render?: (item: T) => React.ReactNode;
  className?: string;
};

export type SortOption = {
  label: string;
  value: string;
};

export type FilterOption = {
  label: string;
  value: string;
};

function SortIcon({
  columnKey,
  sortKey,
  sortDir,
}: {
  columnKey: string;
  sortKey: string | null;
  sortDir: string | null;
}) {
  if (sortKey !== columnKey) {
    return <ArrowUpDownIcon className="h-3.5 w-3.5 opacity-50" />;
  }
  if (sortDir === "asc") {
    return <ArrowUpIcon className="h-3.5 w-3.5" />;
  }
  return <ArrowDownIcon className="h-3.5 w-3.5" />;
}

type DataTableProps<T> = {
  data: T[];
  columns: Column<T>[];
  searchPlaceholder?: string;
  searchKey?: keyof T;
  sortOptions?: SortOption[];
  filterOptions?: FilterOption[];
  filterKey?: keyof T;
  onRowClick?: (item: T) => void;
  rowHref?: (item: T) => string | undefined;
  renderRowActions?: (item: T) => React.ReactNode;
  pageSize?: number;
  pageSizeOptions?: number[];
  onPageSizeChange?: (pageSize: number) => void;
  emptyMessage?: string;
};

export function DataTable<T extends { id: string }>({
  data,
  columns,
  searchPlaceholder = "Search...",
  searchKey,
  sortOptions,
  filterOptions,
  filterKey,
  onRowClick,
  rowHref,
  renderRowActions,
  pageSize: initialPageSize = 10,
  pageSizeOptions,
  onPageSizeChange,
  emptyMessage = "No items found.",
}: DataTableProps<T>) {
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState(sortOptions?.[0]?.value ?? "");
  const [filter, setFilter] = React.useState("all");
  const [page, setPage] = React.useState(1);
  const [internalPageSize, setInternalPageSize] =
    React.useState(initialPageSize);
  // Keep internal state in sync when parent controls the value
  const pageSize = onPageSizeChange ? initialPageSize : internalPageSize;
  const setPageSize = onPageSizeChange
    ? (size: number) => onPageSizeChange(size)
    : setInternalPageSize;

  // Filter data
  const filteredData = React.useMemo(() => {
    let result = [...data];

    // Apply search
    if (search && searchKey) {
      const searchLower = search.toLowerCase();
      result = result.filter((item) => {
        const value = item[searchKey];
        if (typeof value === "string") {
          return value.toLowerCase().includes(searchLower);
        }
        return false;
      });
    }

    // Apply filter
    if (filter !== "all" && filterKey) {
      result = result.filter((item) => {
        const value = item[filterKey];
        return value === filter;
      });
    }

    // Apply sort
    if (sort) {
      const [sortKey, sortDir] = sort.split(":");
      result.sort((a, b) => {
        const aVal = a[sortKey as keyof T];
        const bVal = b[sortKey as keyof T];

        if (aVal instanceof Date && bVal instanceof Date) {
          return sortDir === "desc"
            ? bVal.getTime() - aVal.getTime()
            : aVal.getTime() - bVal.getTime();
        }

        if (typeof aVal === "string" && typeof bVal === "string") {
          return sortDir === "desc"
            ? bVal.localeCompare(aVal)
            : aVal.localeCompare(bVal);
        }

        if (typeof aVal === "number" && typeof bVal === "number") {
          return sortDir === "desc" ? bVal - aVal : aVal - bVal;
        }

        return 0;
      });
    }

    return result;
  }, [data, search, searchKey, filter, filterKey, sort]);

  // Paginate
  const totalPages = Math.ceil(filteredData.length / pageSize);
  const paginatedData = filteredData.slice(
    (page - 1) * pageSize,
    page * pageSize
  );

  // Parse current sort into key and direction
  const [sortKey, sortDir] = sort ? sort.split(":") : [null, null];

  // Hide the sortOptions dropdown when any column has sortable headers,
  // since column-header clicks and the dropdown share the same sort state.
  const hasColumnSort = columns.some((c) => c.sortable);

  const handleColumnSort = (columnKey: string) => {
    if (sortKey === columnKey) {
      setSort(`${columnKey}:${sortDir === "asc" ? "desc" : "asc"}`);
    } else {
      setSort(`${columnKey}:asc`);
    }
  };

  // Reset page when filters change
  React.useEffect(() => {
    setPage(1);
  }, [search, filter, sort, pageSize]);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-4">
        {searchKey && (
          <div className="relative flex-1 max-w-sm">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              aria-label={searchPlaceholder || "Search"}
              placeholder={searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        )}

        <div className="flex items-center gap-2 ml-auto">
          {sortOptions && sortOptions.length > 0 && !hasColumnSort && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Sort:</span>
              <Select value={sort} onValueChange={setSort}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sortOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {filterOptions && filterOptions.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Filter:</span>
              <Select value={filter} onValueChange={setFilter}>
                <SelectTrigger className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {filterOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHead key={String(column.key)} className={column.className}>
                  {column.sortable ? (
                    <button
                      className="flex items-center gap-1 hover:text-foreground transition-colors"
                      onClick={() => handleColumnSort(String(column.key))}
                      type="button"
                    >
                      {column.header}
                      <SortIcon
                        columnKey={String(column.key)}
                        sortDir={sortDir}
                        sortKey={sortKey}
                      />
                    </button>
                  ) : (
                    column.header
                  )}
                </TableHead>
              ))}
              {renderRowActions && (
                <TableHead className="w-[50px]" />
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedData.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length + (renderRowActions ? 1 : 0)}
                  className="h-24 text-center text-muted-foreground"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              paginatedData.map((item) => {
                const href = rowHref?.(item);
                return (
                  <TableRow
                    key={item.id}
                    onClick={href ? undefined : (() => onRowClick?.(item))}
                    className={cn(
                      (onRowClick || href) && "cursor-pointer",
                      href && "relative"
                    )}
                  >
                    {columns.map((column, colIndex) => (
                      <TableCell
                        key={String(column.key)}
                        className={cn(column.className, href && colIndex > 0 && "relative z-[2]")}
                      >
                        {colIndex === 0 && href && (
                          <a
                            href={href}
                            className="absolute inset-0 z-[1]"
                            onClick={(e) => {
                              if (!onRowClick) return;
                              const isModified = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
                              if (e.button === 0 && !isModified) {
                                e.preventDefault();
                                onRowClick(item);
                              }
                            }}
                            tabIndex={-1}
                          >
                            <span className="sr-only">Open</span>
                          </a>
                        )}
                        {column.render
                          ? column.render(item)
                          : String(item[column.key as keyof T] ?? "")}
                      </TableCell>
                    ))}
                    {renderRowActions && (
                      <TableCell
                        className={cn(href && "relative z-10")}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {renderRowActions(item)}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <p className="text-sm text-muted-foreground">
            {filteredData.length} item{filteredData.length !== 1 ? "s" : ""} total
          </p>
          {pageSizeOptions && pageSizeOptions.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Show:</span>
              <Select
                onValueChange={(v) => {
                  setPageSize(Number(v));
                  setPage(1);
                }}
                value={String(pageSize)}
              >
                <SelectTrigger className="w-[80px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {pageSizeOptions.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              <ChevronLeftIcon className="h-4 w-4" />
            </Button>
            <span className="text-sm">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
            >
              <ChevronRightIcon className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
