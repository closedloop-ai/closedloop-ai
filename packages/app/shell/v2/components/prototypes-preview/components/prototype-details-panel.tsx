"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import {
  ExternalLinkIcon,
  EyeIcon,
  MessageSquareIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type Annotation,
  type PrototypeRow,
  type PrototypeVersion,
  people,
} from "../mock";
import { PrototypeStatus } from "../prototype-status";
import { PersonLabel } from "./prototype-people";

export function PrototypeDetailsPanel({
  prototype,
  versions,
  annotations,
  onPrototypeChange,
  onOpenVersion,
}: {
  prototype: PrototypeRow;
  versions: readonly PrototypeVersion[];
  annotations: Annotation[];
  onPrototypeChange: (prototype: PrototypeRow) => void;
  onOpenVersion: (version: number) => void;
}) {
  const [name, setName] = useState(prototype.name);
  const [status, setStatus] = useState(prototype.status);
  const [project, setProject] = useState(prototype.project);
  const [relatedFeature, setRelatedFeature] = useState(
    "PRD-568 Prototypes as Artifacts"
  );
  const [tags, setTags] = useState(prototype.tags);
  const [tagDraft, setTagDraft] = useState("");
  const [ownerId, setOwnerId] = useState(prototype.owner.id);
  const [saveState, setSaveState] = useState<"saved" | "saving">("saved");
  const mountedDetails = useRef(false);
  const ownerOptions = Object.values(people);
  const editableState = [
    name,
    ownerId,
    project,
    relatedFeature,
    status,
    tags.join(","),
  ].join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: editableState is the intentional persistence trigger.
  useEffect(() => {
    if (!editableState) {
      return;
    }
    if (!mountedDetails.current) {
      mountedDetails.current = true;
      return;
    }
    const owner =
      ownerOptions.find((person) => person.id === ownerId) ?? prototype.owner;
    onPrototypeChange({
      ...prototype,
      name,
      owner,
      project,
      status,
      tags,
    });
    setSaveState("saving");
    const saveTimer = setTimeout(() => setSaveState("saved"), 600);
    return () => clearTimeout(saveTimer);
  }, [editableState]);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
            Prototype
          </p>
          <Input
            aria-label="Prototype name"
            className="mt-1 h-10 w-[30rem] max-w-full font-semibold text-xl tracking-tight"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
          <p className="mt-2 max-w-3xl text-muted-foreground text-sm">
            {prototype.description}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            aria-live="polite"
            className="min-w-12 text-right text-muted-foreground text-xs"
          >
            {saveState === "saving" ? "Saving…" : "Saved"}
          </span>
          <Select
            onValueChange={(value) =>
              setStatus(
                value as (typeof PrototypeStatus)[keyof typeof PrototypeStatus]
              )
            }
            value={status}
          >
            <SelectTrigger aria-label="Prototype status" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value={PrototypeStatus.Draft}>Draft</SelectItem>
              <SelectItem value={PrototypeStatus.InProgress}>
                In progress
              </SelectItem>
              <SelectItem value={PrototypeStatus.ReadyForReview}>
                Ready for review
              </SelectItem>
              <SelectItem value={PrototypeStatus.HandedOff}>
                Handed off
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-8 grid gap-5">
        <section className="rounded-xl border bg-background">
          <div className="border-b px-5 py-4">
            <h2 className="font-semibold text-sm">Artifact details</h2>
            <p className="mt-1 text-muted-foreground text-xs">
              Core identity and relationships for this prototype.
            </p>
          </div>
          <dl className="grid gap-x-10 gap-y-6 p-5 sm:grid-cols-2">
            <div>
              <dt className="font-medium text-muted-foreground text-xs">
                Project
              </dt>
              <dd className="mt-1">
                <Select onValueChange={setProject} value={project}>
                  <SelectTrigger aria-label="Project" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Ideas Triage">Ideas Triage</SelectItem>
                    <SelectItem value="ClosedLoop AI">ClosedLoop AI</SelectItem>
                    <SelectItem value="Documents">Documents</SelectItem>
                    <SelectItem value="Desktop">Desktop</SelectItem>
                  </SelectContent>
                </Select>
              </dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground text-xs">
                Related feature
              </dt>
              <dd className="mt-1">
                <Select
                  onValueChange={setRelatedFeature}
                  value={relatedFeature}
                >
                  <SelectTrigger
                    aria-label="Related feature"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PRD-568 Prototypes as Artifacts">
                      PRD-568 Prototypes as Artifacts
                    </SelectItem>
                    <SelectItem value="PRD-521 Branch details">
                      PRD-521 Branch details
                    </SelectItem>
                    <SelectItem value="None">None</SelectItem>
                  </SelectContent>
                </Select>
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="font-medium text-muted-foreground text-xs">
                Preview URL
              </dt>
              <dd className="mt-1 flex min-w-0 items-center gap-2">
                <a
                  className="min-w-0 flex-1 truncate text-primary text-sm hover:underline"
                  href={prototype.previewUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {prototype.previewUrl}
                </a>
                <Button asChild size="icon-sm" variant="ghost">
                  <a
                    aria-label="Open preview URL"
                    href={prototype.previewUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <ExternalLinkIcon />
                  </a>
                </Button>
              </dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground text-xs">
                Tags
              </dt>
              <dd className="mt-2 flex flex-wrap items-center gap-1.5">
                {tags.map((tag) => (
                  <Chip className="gap-1" key={tag} variant="muted">
                    {tag}
                    <button
                      aria-label={`Remove ${tag} tag`}
                      onClick={() =>
                        setTags((current) =>
                          current.filter((item) => item !== tag)
                        )
                      }
                      type="button"
                    >
                      <XIcon className="size-3" />
                    </button>
                  </Chip>
                ))}
                <Input
                  aria-label="Add tag"
                  className="h-7 w-28"
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") {
                      return;
                    }
                    event.preventDefault();
                    const nextTag = tagDraft.trim();
                    if (nextTag && !tags.includes(nextTag)) {
                      setTags((current) => [...current, nextTag]);
                    }
                    setTagDraft("");
                  }}
                  placeholder="Add tag"
                  value={tagDraft}
                />
              </dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground text-xs">
                Last activity
              </dt>
              <dd className="mt-1 text-sm">
                {prototype.updated} by {prototype.updatedBy.name}
              </dd>
            </div>
          </dl>
        </section>

        <section className="rounded-xl border bg-background">
          <div className="border-b px-5 py-4">
            <h2 className="font-semibold text-sm">People</h2>
            <p className="mt-1 text-muted-foreground text-xs">
              Artifact ownership and participation.
            </p>
          </div>
          <div className="grid gap-8 p-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
            <div>
              <p className="font-medium text-muted-foreground text-xs">Owner</p>
              <Select onValueChange={setOwnerId} value={ownerId}>
                <SelectTrigger aria-label="Owner" className="mt-3 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ownerOptions.map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="font-medium text-muted-foreground text-xs">
                  Collaborators
                </p>
                <Chip variant="muted">Derived participation</Chip>
              </div>
              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3">
                {prototype.collaborators.map((person) => (
                  <PersonLabel key={person.id} person={person} />
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-xl border bg-background">
          <div className="border-b px-5 py-4">
            <h2 className="font-semibold text-sm">Version history</h2>
            <p className="mt-1 text-muted-foreground text-xs">
              Immutable version metadata, authorship, and version-scoped review
              activity.
            </p>
          </div>
          <div className="overflow-x-auto">
            <div className="grid min-w-[56rem] grid-cols-[5rem_minmax(12rem,1fr)_11rem_8rem_8rem_8rem] border-b bg-muted/40 px-5 py-2 font-medium text-muted-foreground text-xs">
              <span>Version</span>
              <span>Change summary</span>
              <span>Author</span>
              <span>Published</span>
              <span>Open comments</span>
              <span className="text-right">Preview</span>
            </div>
            <div className="min-w-[56rem]">
              {versions.map((item) => {
                const commentCount = annotations.filter(
                  (annotation) =>
                    annotation.version === item.number && !annotation.resolved
                ).length;
                return (
                  <div
                    className="grid min-h-14 grid-cols-[5rem_minmax(12rem,1fr)_11rem_8rem_8rem_8rem] items-center border-b px-5 text-sm last:border-b-0"
                    key={item.number}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      {item.label}
                      {item.number === prototype.version ? (
                        <span className="size-1.5 rounded-full bg-success" />
                      ) : null}
                    </span>
                    <span className="truncate pr-6 text-muted-foreground">
                      {item.changeSummary}
                    </span>
                    <PersonLabel person={item.createdBy} />
                    <span className="text-muted-foreground text-xs">
                      {item.createdAt}
                    </span>
                    <span>
                      <Chip className="gap-1" variant="muted">
                        <MessageSquareIcon className="size-3" />
                        {commentCount}
                      </Chip>
                    </span>
                    <span className="flex justify-end">
                      {item.number === prototype.version ? (
                        <span className="text-muted-foreground text-xs">
                          Current
                        </span>
                      ) : (
                        <Button
                          onClick={() => onOpenVersion(item.number)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          <EyeIcon />
                          Open preview
                        </Button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
