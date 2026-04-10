"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import {
  FEATURE_STATUS_OPTIONS,
  FeatureStatus,
} from "@repo/api/src/types/feature";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@repo/design-system/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  type User,
  UserSelectPopover,
} from "@repo/design-system/components/ui/user-select-popover";
import { ChevronDownIcon, FileTextIcon, LoaderIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  featurePriorityLabels,
  featureStatusLabels,
} from "@/components/status-badge";
import { useArtifactsByProject } from "@/hooks/queries/use-artifacts";
import { useCreateEntityLink } from "@/hooks/queries/use-entity-links";
import { useCreateFeature } from "@/hooks/queries/use-features";
import { useProjectsByTeam } from "@/hooks/queries/use-projects";
import { useTeamMembers } from "@/hooks/queries/use-teams";
import { ARTIFACT_TYPE_LABELS } from "@/lib/project-constants";
import { transformApiUserToSelectUser } from "@/lib/user-utils";

type CreateFeatureModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: string;
  teamId: string;
};

export function CreateFeatureModal({
  open,
  onOpenChange,
  projectId,
  teamId,
}: CreateFeatureModalProps) {
  const router = useRouter();

  // Project selection (when projectId prop is not provided)
  const showProjectSelector = !projectId;
  const [selectedProjectId, setSelectedProjectId] = useState(projectId ?? "");
  const { data: teamProjects = [], isLoading: isLoadingProjects } =
    useProjectsByTeam(teamId, { enabled: open && showProjectSelector });

  // Form state
  const [title, setTitle] = useState("");
  const [selectedArtifacts, setSelectedArtifacts] = useState<
    ArtifactWithWorkstream[]
  >([]);
  const [selectedAssignee, setSelectedAssignee] = useState<User | null>(null);
  const [priority, setPriority] = useState<Priority>(Priority.Medium);
  const [status, setStatus] = useState<FeatureStatus>(FeatureStatus.NotStarted);
  const [error, setError] = useState<string | null>(null);
  const [relationshipsOpen, setRelationshipsOpen] = useState(false);

  // Queries
  const { data: teamMembers = [], isLoading: isLoadingUsers } = useTeamMembers(
    teamId,
    { enabled: open }
  );
  const transformedUsers = useMemo(
    () => teamMembers.map((m) => transformApiUserToSelectUser(m.user)),
    [teamMembers]
  );

  const { data: artifacts = [] } = useArtifactsByProject(selectedProjectId, {
    enabled: open && !!selectedProjectId,
  });
  // Filter out already-selected artifacts
  const availableArtifacts = useMemo(() => {
    const selectedIds = new Set(selectedArtifacts.map((a) => a.id));
    return artifacts.filter((a) => !selectedIds.has(a.id));
  }, [artifacts, selectedArtifacts]);

  // Mutations
  const createFeatureMutation = useCreateFeature();
  const createEntityLinkMutation = useCreateEntityLink();

  const isSubmitting =
    createFeatureMutation.isPending || createEntityLinkMutation.isPending;

  const handleAddArtifact = (artifact: ArtifactWithWorkstream) => {
    setSelectedArtifacts((prev) => [...prev, artifact]);
    setRelationshipsOpen(false);
  };

  const handleRemoveArtifact = (artifactId: string) => {
    setSelectedArtifacts((prev) => prev.filter((a) => a.id !== artifactId));
  };

  const handleProjectChange = (newProjectId: string) => {
    setSelectedProjectId(newProjectId);
    // Clear project-scoped state so stale selections don't carry over
    setSelectedArtifacts([]);
  };

  const resetForm = () => {
    setTitle("");
    setSelectedArtifacts([]);
    setSelectedAssignee(null);
    setPriority(Priority.Medium);
    setStatus(FeatureStatus.NotStarted);
    setError(null);
    setRelationshipsOpen(false);
    if (showProjectSelector) {
      setSelectedProjectId("");
    }
  };

  const handleClose = () => {
    onOpenChange(false);
    resetForm();
  };

  const handleSubmit = () => {
    setError(null);
    if (!selectedProjectId) {
      setError("Please select a project");
      return;
    }
    if (!title.trim()) {
      setError("Please enter a title");
      return;
    }

    createFeatureMutation.mutate(
      {
        projectId: selectedProjectId,
        title: title.trim(),
        status,
        priority,
        assigneeId: selectedAssignee?.id,
      },
      {
        onSuccess: async (feature) => {
          if (selectedArtifacts.length > 0) {
            try {
              await Promise.all(
                selectedArtifacts.map((artifact) =>
                  createEntityLinkMutation.mutateAsync({
                    sourceId: artifact.id,
                    sourceType: EntityType.Artifact,
                    targetId: feature.id,
                    targetType: EntityType.Feature,
                    linkType: LinkType.Produces,
                  })
                )
              );
            } catch {
              toast.error(
                "Feature created, but some relationships failed to save."
              );
            }
          }
          handleClose();
          router.push(`/features/${feature.slug}`);
        },
        onError: () => {
          setError("Failed to create feature. Please try again.");
        },
      }
    );
  };

  return (
    <Dialog
      onOpenChange={(newOpen) => {
        if (newOpen) {
          onOpenChange(true);
        } else {
          handleClose();
        }
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Create New Feature</DialogTitle>
          <DialogDescription className="sr-only">
            Create a new feature for this project.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-6">
          {error ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive text-sm">
              {error}
            </div>
          ) : null}

          {showProjectSelector ? (
            <div className="space-y-2">
              <Label
                className="font-normal text-muted-foreground text-xs"
                htmlFor="feature-project"
              >
                Project<span className="text-destructive">*</span>
              </Label>
              <Select
                disabled={isLoadingProjects}
                onValueChange={handleProjectChange}
                value={selectedProjectId}
              >
                <SelectTrigger id="feature-project">
                  <SelectValue
                    placeholder={
                      isLoadingProjects
                        ? "Loading projects..."
                        : "Select a project..."
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {teamProjects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label
              className="font-normal text-muted-foreground text-xs"
              htmlFor="feature-title"
            >
              Feature Title<span className="text-destructive">*</span>
            </Label>
            <Input
              id="feature-title"
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Feature Title"
              value={title}
            />
          </div>

          <div className="space-y-2">
            <Label className="font-normal text-muted-foreground text-xs">
              Add Relationships
            </Label>
            <Popover
              onOpenChange={setRelationshipsOpen}
              open={relationshipsOpen}
            >
              <PopoverTrigger asChild>
                <Button
                  className="w-full justify-between font-normal text-muted-foreground"
                  variant="outline"
                >
                  Select additional context...
                  <ChevronDownIcon className="h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[460px] p-0">
                <Command>
                  <CommandInput placeholder="Search artifacts..." />
                  <CommandList>
                    <CommandEmpty>No artifacts found.</CommandEmpty>
                    <CommandGroup>
                      {availableArtifacts.map((artifact) => (
                        <CommandItem
                          key={artifact.id}
                          onSelect={() => handleAddArtifact(artifact)}
                        >
                          <FileTextIcon className="h-4 w-4 shrink-0" />
                          <span className="flex-1 truncate">
                            {artifact.title}
                          </span>
                          <span className="ml-2 text-muted-foreground text-xs">
                            {ARTIFACT_TYPE_LABELS[artifact.type] ??
                              artifact.type}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {selectedArtifacts.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selectedArtifacts.map((artifact) => (
                  <Badge
                    className="gap-1 pl-2"
                    key={artifact.id}
                    variant="outline"
                  >
                    <FileTextIcon className="h-3 w-3" />
                    {artifact.title}
                    <button
                      className="ml-1 rounded-sm opacity-70 hover:opacity-100"
                      onClick={() => handleRemoveArtifact(artifact.id)}
                      type="button"
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label className="font-normal text-muted-foreground text-xs">
              Assignee
            </Label>
            <UserSelectPopover
              className="w-full"
              disabled={isLoadingUsers}
              onSelect={setSelectedAssignee}
              placeholder={
                isLoadingUsers ? "Loading users..." : "Select Assignee"
              }
              users={transformedUsers}
              value={selectedAssignee}
            />
          </div>

          <div className="space-y-2">
            <Label className="font-normal text-muted-foreground text-xs">
              Priority
            </Label>
            <Select
              onValueChange={(v: Priority) => setPriority(v)}
              value={priority}
            >
              <SelectTrigger>
                <SelectValue placeholder="Not Set" />
              </SelectTrigger>
              <SelectContent>
                {Object.values(Priority).map((p) => (
                  <SelectItem key={p} value={p}>
                    {featurePriorityLabels[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="font-normal text-muted-foreground text-xs">
              Status
            </Label>
            <Select
              onValueChange={(v: FeatureStatus) => setStatus(v)}
              value={status}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FEATURE_STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {featureStatusLabels[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!(title.trim() && selectedProjectId) || isSubmitting}
            onClick={handleSubmit}
          >
            {isSubmitting ? (
              <>
                <LoaderIcon className="h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              "Create Feature"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
