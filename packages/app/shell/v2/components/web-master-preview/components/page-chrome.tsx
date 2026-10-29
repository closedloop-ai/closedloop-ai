"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@repo/design-system/components/ui/breadcrumb";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import { Input } from "@repo/design-system/components/ui/input";
import { SidebarTrigger } from "@repo/design-system/components/ui/sidebar";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { Fragment, type ReactNode, useEffect, useState } from "react";

// Shared page header and content frame for every Web Master artifact route.
// Artifact specializations supply only their breadcrumbs, actions, and tabs;
// this component owns the surrounding chrome so those patterns cannot drift.

export type Crumb = {
  label: string;
  editableLabel?: string;
  href?: string;
  isCurrent?: boolean;
  onLabelChange?: (label: string) => void;
  onSelect?: () => void;
  prefix?: string;
};

type PageChromeProps = {
  readonly breadcrumbs: readonly Crumb[];
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  /** Control rendered left-aligned, immediately after the breadcrumb. */
  readonly leadingAction?: ReactNode;
  readonly navigation?: ReactNode;
};

export const PageChrome = ({
  breadcrumbs,
  actions,
  children,
  leadingAction,
  navigation,
}: PageChromeProps) => (
  <>
    <header
      className={`flex h-12 shrink-0 items-center justify-between gap-4 px-4 ${
        navigation ? "" : "border-border border-b"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="-ml-1 text-muted-foreground" />
        <Breadcrumb>
          <BreadcrumbList>
            {breadcrumbs.map((crumb, index) => (
              <Fragment key={crumb.label}>
                <BreadcrumbItem>
                  <BreadcrumbCrumb crumb={crumb} />
                </BreadcrumbItem>
                {index < breadcrumbs.length - 1 ? (
                  <BreadcrumbSeparator />
                ) : null}
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
        {leadingAction ? (
          <div className="flex shrink-0 items-center">{leadingAction}</div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-2">{actions}</div>
      ) : null}
    </header>
    {navigation}
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {children}
    </div>
  </>
);

function BreadcrumbCrumb({ crumb }: { crumb: Crumb }) {
  if (crumb.isCurrent && crumb.onLabelChange) {
    return <EditableBreadcrumbTitle crumb={crumb} />;
  }
  if (!crumb.isCurrent && crumb.href) {
    return (
      <BreadcrumbLink asChild>
        <Link href={crumb.href}>{crumb.label}</Link>
      </BreadcrumbLink>
    );
  }
  if (crumb.isCurrent || !crumb.onSelect) {
    return <BreadcrumbPage>{crumb.label}</BreadcrumbPage>;
  }
  return (
    <BreadcrumbLink asChild>
      <button className="cursor-pointer" onClick={crumb.onSelect} type="button">
        {crumb.label}
      </button>
    </BreadcrumbLink>
  );
}

function EditableBreadcrumbTitle({ crumb }: { crumb: Crumb }) {
  const value = crumb.editableLabel ?? crumb.label;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) {
      setDraft(value);
    }
  }, [editing, value]);

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };
  const commit = () => {
    const next = draft.trim();
    if (!next) {
      cancel();
      return;
    }
    if (next !== value) {
      crumb.onLabelChange?.(next);
    }
    setEditing(false);
  };

  return (
    <BreadcrumbPage className="flex min-w-0 items-center gap-1.5">
      {crumb.prefix ? (
        <span className="shrink-0 text-muted-foreground">{crumb.prefix}</span>
      ) : null}
      {editing ? (
        <Input
          aria-label="Artifact title"
          autoFocus
          className="h-7 min-w-40 max-w-[min(52vw,42rem)] px-2 py-0 text-sm"
          onBlur={commit}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          }}
          style={{ width: `${Math.min(52, Math.max(18, draft.length + 2))}ch` }}
          value={draft}
        />
      ) : (
        <button
          aria-label={`Edit artifact title, currently ${value}`}
          className={cn(
            "min-w-0 truncate rounded-sm px-1 py-0.5 text-left hover:bg-accent",
            CHIP_FOCUS_RING_CLASS
          )}
          onClick={() => setEditing(true)}
          title={value}
          type="button"
        >
          {value}
        </button>
      )}
    </BreadcrumbPage>
  );
}
