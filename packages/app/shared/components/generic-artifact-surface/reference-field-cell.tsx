"use client";

import { toggleListValue } from "@repo/app/shared/lib/toggle-list-value";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { toast } from "@repo/design-system/components/ui/sonner";
import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import { TableReferenceListCell } from "@repo/design-system/components/ui/table-cell-list-primitives";
import {
  BotIcon,
  CheckIcon,
  FileIcon,
  GitBranchIcon,
  HistoryIcon,
  Layers2Icon,
  LinkIcon,
  type LucideIcon,
  SquareCheckIcon,
} from "lucide-react";
import { useState } from "react";

type ReferenceKind =
  | "Agentic Components"
  | "Branches"
  | "Documents"
  | "Issues"
  | "Projects"
  | "Sessions";

type ReferenceOption = {
  icon: LucideIcon;
  id: string;
  kind: ReferenceKind;
  slug: string;
  title: string;
};

export function EditableReferenceFieldCell({
  field,
  onChange,
  values,
}: {
  field: CustomFieldDefinition;
  onChange: (value: string | readonly string[] | null) => void;
  values: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const source = field.sources?.[0] ?? "Artifacts";
  const multiple = field.type === "Reference (multi)" || source === "Artifacts";
  const options = referenceOptions(source);
  const matchingOptions = options.filter((option) =>
    `${option.slug} ${option.title}`
      .toLowerCase()
      .includes(query.trim().toLowerCase())
  );
  const toggleReference = (id: string) => {
    const next = multiple ? toggleListValue(values, id) : [id];
    onChange(multiple ? next : id);
    setQuery("");
    if (!multiple) {
      setOpen(false);
    }
    toast.success(multiple ? "References updated" : "Reference updated");
  };
  return (
    <Popover
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setQuery("");
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <button
          aria-label={`Edit ${source.toLowerCase()} reference`}
          className="group w-full max-w-full rounded-md px-1 py-0.5 text-left text-sm hover:bg-muted"
          type="button"
        >
          <TableReferenceListCell
            references={values.map((value) => {
              const option = REFERENCE_OPTIONS.find(
                (candidate) => candidate.id === value
              );
              return {
                icon: option?.icon ?? LinkIcon,
                id: `${field.id}-${value}`,
                label: option?.slug ?? value,
                tooltip: option ? `${option.slug} · ${option.title}` : value,
              };
            })}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[360px] overflow-hidden p-0">
        <div className="border-b p-2">
          <div className="flex items-center gap-2 rounded-md border bg-background px-2">
            <LinkIcon className="size-4 text-muted-foreground" />
            <input
              aria-label={`Search ${source.toLowerCase()} references`}
              autoFocus
              className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${source}…`}
              value={query}
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {matchingOptions.map((option) => {
            const selected = values.includes(option.id);
            const Icon = option.icon;
            return (
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted"
                key={option.id}
                onClick={() => toggleReference(option.id)}
                type="button"
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="shrink-0 font-mono text-muted-foreground text-xs">
                  {option.slug}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {option.title}
                </span>
                {selected ? <CheckIcon className="size-4" /> : null}
              </button>
            );
          })}
          {matchingOptions.length === 0 ? (
            <div className="px-3 py-8 text-center text-muted-foreground text-sm">
              No matching artifacts
            </div>
          ) : null}
        </div>
        {multiple && values.length > 0 ? (
          <div className="flex items-center justify-between border-t px-3 py-2">
            <span className="text-muted-foreground text-xs">
              {values.length} selected
            </span>
            <Button onClick={() => setOpen(false)} size="sm">
              Done
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function referenceOptions(source: string): readonly ReferenceOption[] {
  if (source === "Artifacts") {
    return REFERENCE_OPTIONS;
  }
  return REFERENCE_OPTIONS.filter((option) => option.kind === source);
}

const REFERENCE_OPTIONS: readonly ReferenceOption[] = [
  {
    icon: SquareCheckIcon,
    id: "FEA-2481",
    kind: "Issues",
    slug: "FEA-2481",
    title: "Unified artifact experience",
  },
  {
    icon: SquareCheckIcon,
    id: "ISS-4382",
    kind: "Issues",
    slug: "ISS-4382",
    title: "Make documents a first-class artifact",
  },
  {
    icon: GitBranchIcon,
    id: "BRN-grid-table-v2",
    kind: "Branches",
    slug: "BRN-grid-table-v2",
    title: "Grid Table V2 prototype promotion",
  },
  {
    icon: HistoryIcon,
    id: "SES-7B91",
    kind: "Sessions",
    slug: "SES-7B91",
    title: "Prototype generic artifact shells",
  },
  {
    icon: FileIcon,
    id: "DOC-184",
    kind: "Documents",
    slug: "DOC-184",
    title: "Artifact interaction principles",
  },
  {
    icon: BotIcon,
    id: "AGT-review-soul",
    kind: "Agentic Components",
    slug: "AGT-review-soul",
    title: "Review soul",
  },
  {
    icon: Layers2Icon,
    id: "PRJ-symphony",
    kind: "Projects",
    slug: "PRJ-symphony",
    title: "Symphony",
  },
];
