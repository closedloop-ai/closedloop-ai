"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import { toast } from "@repo/design-system/components/ui/sonner";
import { cn } from "@repo/design-system/lib/utils";
import { GitCompareIcon, SlidersHorizontalIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { GenericArtifact } from "../mock";
import { personInitials } from "./artifact-people";

export type ArtifactVersionRecord = {
  author: string;
  id: string;
  state: string;
  updated: string;
};
export type ArtifactActivityRecord = {
  actor: string;
  body: ReactNode;
  date: string;
  id: string;
  kind: "comment" | "event";
  version?: string;
};
const VERSION_PATTERN = /^(\d+)$/;

export function ArtifactActivityTrace({
  artifact,
  records,
}: {
  artifact: GenericArtifact;
  records?: readonly ArtifactActivityRecord[];
}) {
  const [view, setView] = useState<"comments" | "all">("all");
  const [oldestFirst, setOldestFirst] = useState(true);
  const activity = records ?? [
    {
      actor: "Andrew Eye",
      body: <>created this artifact</>,
      date: "Jul 30",
      id: "created",
      kind: "event" as const,
    },
    {
      actor: "Andrew Eye",
      body: (
        <>
          added this artifact to{" "}
          <button className="font-medium text-primary" type="button">
            {artifact.project ?? "Artifact foundations"}
          </button>
        </>
      ),
      date: "Jul 30",
      id: "project-added",
      kind: "event" as const,
    },
    {
      actor: "Parker Byrd",
      body: <>changed the owner to Parker Byrd</>,
      date: "Jul 30",
      id: "owner-changed",
      kind: "event" as const,
    },
    {
      actor: "Jordan Lee",
      body: <>commented “The revision trace now reflects the final review.”</>,
      date: "just now",
      id: "comment-added",
      kind: "comment" as const,
      version: artifact.currentVersion,
    },
    {
      actor: "Andrew Eye",
      body: (
        <>commented “The earlier interaction contract is ready to compare.”</>
      ),
      date: "Jul 28",
      id: "comment-previous-version",
      kind: "comment" as const,
      version: previousVersion(artifact.currentVersion, 1),
    },
  ];
  const visible = activity.filter(
    (item) => view === "all" || item.kind === "comment"
  );
  const ordered = oldestFirst ? visible : [...visible].reverse();
  return (
    <div className="border-y">
      <div className="flex h-12 items-end justify-between border-b px-1">
        <div className="flex h-full items-end">
          {[
            ["comments", "Comments"],
            ["all", "All activity"],
          ].map(([value, label]) => (
            <button
              aria-pressed={view === value}
              className={cn(
                "h-full border-b-2 px-4 font-medium text-sm",
                view === value
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground"
              )}
              key={value}
              onClick={() => setView(value as "comments" | "all")}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="mb-2 inline-flex items-center gap-2 rounded-md px-2 py-1 text-muted-foreground text-sm hover:bg-muted"
          onClick={() => setOldestFirst((current) => !current)}
          type="button"
        >
          <SlidersHorizontalIcon className="size-4" />
          {oldestFirst ? "Oldest" : "Newest"}
        </button>
      </div>
      <div className="space-y-4 px-4 py-5">
        {ordered.map((item) => (
          <div className="flex gap-3" key={item.id}>
            <Avatar className="size-7 shrink-0">
              <AvatarFallback className="text-[10px]">
                {personInitials(item.actor)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 text-muted-foreground text-sm">
              <span className="font-semibold text-foreground">
                {item.actor}
              </span>{" "}
              {item.body}
              {item.version ? (
                <Chip className="mx-1 align-middle" size="sm" variant="muted">
                  {item.version}
                </Chip>
              ) : null}
              · {item.date}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ArtifactVersionHistory({
  artifact,
  initialVersion,
  onVersionChange,
  records,
}: {
  artifact: GenericArtifact;
  initialVersion?: string | null;
  onVersionChange?: (version: string) => void;
  records?: readonly ArtifactVersionRecord[];
}) {
  const versions = records ?? [
    {
      id: artifact.currentVersion,
      author: artifact.owner,
      state: "Current",
      updated: artifact.updated,
    },
    {
      id: previousVersion(artifact.currentVersion, 1),
      author: "Andrew Eye",
      state: "Published",
      updated: "2d ago",
    },
    {
      id: previousVersion(artifact.currentVersion, 2),
      author: "Parker Byrd",
      state: "Published",
      updated: "6d ago",
    },
  ];
  const [selectedVersion, setSelectedVersion] = useState(
    versions.some((version) => version.id === initialVersion)
      ? (initialVersion ?? "")
      : (versions[0]?.id ?? "")
  );
  const initialVersionIsKnown = initialVersion
    ? versions.some((version) => version.id === initialVersion)
    : false;
  useEffect(() => {
    if (initialVersion && initialVersionIsKnown) {
      setSelectedVersion(initialVersion);
    }
  }, [initialVersion, initialVersionIsKnown]);
  return (
    <div>
      <div className="grid grid-cols-[7rem_minmax(0,1fr)_8rem_8rem] border-b px-2 pb-2 text-muted-foreground text-xs">
        <span>Version</span>
        <span>Author</span>
        <span>State</span>
        <span>Updated</span>
      </div>
      {versions.map((version) => (
        <button
          aria-pressed={selectedVersion === version.id}
          className={cn(
            "grid w-full grid-cols-[7rem_minmax(0,1fr)_8rem_8rem] items-center rounded-md px-2 py-2.5 text-left text-sm transition-colors hover:bg-muted/60",
            selectedVersion === version.id && "bg-muted"
          )}
          key={version.id}
          onClick={() => {
            setSelectedVersion(version.id);
            onVersionChange?.(version.id);
          }}
          type="button"
        >
          <span className="font-medium">{version.id}</span>
          <span>{version.author}</span>
          <span className="text-muted-foreground">{version.state}</span>
          <span className="text-muted-foreground">{version.updated}</span>
        </button>
      ))}
      <div className="mt-3 flex justify-end gap-2 border-t pt-3">
        <Button
          onClick={() => toast.success(`Opened ${selectedVersion}`)}
          size="sm"
          variant="outline"
        >
          Open version
        </Button>
        {selectedVersion === artifact.currentVersion ? null : (
          <>
            <Button
              onClick={() =>
                toast.success(`Comparing ${selectedVersion} with current`)
              }
              size="sm"
              variant="outline"
            >
              <GitCompareIcon />
              Compare
            </Button>
            <Button
              onClick={() => toast.success(`${selectedVersion} restored`)}
              size="sm"
            >
              Restore
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function previousVersion(version: string, decrement: number) {
  const match = version.match(VERSION_PATTERN);
  if (!match) {
    return String(Math.max(1, 3 - decrement));
  }
  return String(Math.max(1, Number(match[1]) - decrement));
}
