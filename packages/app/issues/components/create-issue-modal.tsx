"use client";

import { LinkType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  type Document,
  DocumentType,
  type DocumentWithProject,
  ISSUE_STATUS_OPTIONS,
  IssueStatus,
} from "@repo/api/src/types/document";
// Issues are Feature documents; reuse document creation and project relationship authority.
import { useCreateArtifactLink } from "@repo/app/documents/hooks/use-artifact-links";
import {
  useCreateDocument,
  useDocumentsByProject,
} from "@repo/app/documents/hooks/use-documents";
import { getDocumentRoute } from "@repo/app/documents/lib/document-navigation";
import { useProjects } from "@repo/app/projects/hooks/use-projects";
import { DOCUMENT_TYPE_LABELS } from "@repo/app/projects/lib/project-constants";
import { issueStatusLabels } from "@repo/app/shared/components/status-badge";
import {
  PRIORITY_LABELS,
  PRIORITY_VALUES_LOWEST_FIRST,
} from "@repo/app/shared/lib/priority-constants";
import { transformApiUserToSelectUser } from "@repo/app/shared/lib/user-utils";
import { useTeamMembers } from "@repo/app/teams/hooks/use-teams";
import { useOrganizationUsers } from "@repo/app/users/hooks/use-users";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
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
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { ChevronDownIcon, FileTextIcon, LoaderIcon, XIcon } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

export type CreateIssueModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Scopes the project and assignee choices to one team; omitted, the whole org. */
  teamId?: string;
  /** Fixes the issue's project and hides the project selector. */
  projectId?: string;
  initialStatus?: IssueStatus;
  /** Replaces the default navigation to the created issue. */
  onSuccess?: (issue: Document) => void;
};

export function CreateIssueModal({
  open,
  onOpenChange,
  teamId,
  projectId,
  initialStatus = IssueStatus.Backlog,
  onSuccess,
}: Readonly<CreateIssueModalProps>) {
  const navigation = useNavigation();
  const orgPath = useOrgPath();
  const showProjectSelector = !projectId;
  const [selectedProjectId, setSelectedProjectId] = useState(projectId ?? "");
  const { data: projects = [], isLoading: isLoadingProjects } = useProjects(
    teamId,
    { enabled: open && showProjectSelector }
  );

  // Form state
  const [title, setTitle] = useState("");
  const [selectedArtifacts, setSelectedArtifacts] = useState<
    DocumentWithProject[]
  >([]);
  const [selectedAssignee, setSelectedAssignee] = useState<User | null>(null);
  const [priority, setPriority] = useState<Priority>(Priority.Medium);
  // Human-created Features default to BACKLOG (PRD-495).
  const [selectedStatus, setSelectedStatus] = useState<IssueStatus>();
  const status = selectedStatus ?? initialStatus;
  const [error, setError] = useState<string | null>(null);
  const [relationshipsOpen, setRelationshipsOpen] = useState(false);

  // Queries
  const teamMembers = useTeamMembers(teamId ?? "", {
    enabled: open && teamId !== undefined,
  });
  const organizationUsers = useOrganizationUsers({
    enabled: open && teamId === undefined,
  });
  const isLoadingUsers =
    teamId === undefined ? organizationUsers.isLoading : teamMembers.isLoading;
  const transformedUsers = useMemo(
    () =>
      teamId === undefined
        ? (organizationUsers.data ?? []).map(transformApiUserToSelectUser)
        : (teamMembers.data ?? []).map((member) =>
            transformApiUserToSelectUser(member.user)
          ),
    [teamId, organizationUsers.data, teamMembers.data]
  );

  const { data: artifacts = [] } = useDocumentsByProject(selectedProjectId, {
    enabled: open && !!selectedProjectId,
  });
  // Filter out already-selected artifacts
  const availableArtifacts = useMemo(() => {
    const selectedIds = new Set(selectedArtifacts.map((a) => a.id));
    return artifacts.filter((a) => !selectedIds.has(a.id));
  }, [artifacts, selectedArtifacts]);

  // Mutations
  const createFeatureMutation = useCreateDocument();
  // One summary per created issue, however many of its links fail
  // (ISS-11741). Keyed by the new issue's id, which every link of one submit
  // carries as its target, so a link that fails after the modal navigated
  // away still counts against its own submit.
  const [issuesWithReportedLinkFailure] = useState(() => new Set<string>());
  const createArtifactLinkMutation = useCreateArtifactLink({
    onError: (_error, { targetId }) => {
      if (issuesWithReportedLinkFailure.has(targetId)) {
        return;
      }
      issuesWithReportedLinkFailure.add(targetId);
      toast.error("Issue created, but some relationships failed to save.");
    },
  });

  const isSubmitting =
    createFeatureMutation.isPending || createArtifactLinkMutation.isPending;

  const handleAddArtifact = (artifact: DocumentWithProject) => {
    setSelectedArtifacts((prev) => [...prev, artifact]);
    setRelationshipsOpen(false);
  };

  const handleRemoveArtifact = (documentId: string) => {
    setSelectedArtifacts((prev) => prev.filter((a) => a.id !== documentId));
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
    setSelectedStatus(undefined);
    setError(null);
    setRelationshipsOpen(false);
    setSelectedProjectId(projectId ?? "");
  };

  const handleClose = () => {
    onOpenChange(false);
    resetForm();
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
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
        type: DocumentType.Feature,
        projectId: selectedProjectId,
        title: title.trim(),
        content: "",
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
                  createArtifactLinkMutation.mutateAsync({
                    sourceId: artifact.id,
                    targetId: feature.id,
                    linkType: LinkType.Produces,
                  })
                )
              );
            } catch {
              // Reported by the link mutation's `onError` above.
            }
          }
          handleClose();
          if (onSuccess) {
            onSuccess(feature);
            return;
          }
          const route = getDocumentRoute(feature);
          if (route) {
            navigation.navigate(orgPath(route));
          }
        },
        onError: () => {
          setError("Failed to create issue. Please try again.");
        },
      }
    );
  };

  return (
    <Dialog
      onOpenChange={(newOpen) => {
        if (newOpen) {
          onOpenChange(true);
        } else if (!isSubmitting) {
          handleClose();
        }
      }}
      open={open}
    >
      <DialogContent
        className="sm:max-w-lg"
        onEscapeKeyDown={(event) => {
          if (isSubmitting) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          if (isSubmitting) {
            event.preventDefault();
          }
        }}
      >
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create New Issue</DialogTitle>
            <DialogDescription className="sr-only">
              Create a new issue for this project.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-6">
            {error ? (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
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
                    {projects.map((p) => (
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
                Issue Title<span className="text-destructive">*</span>
              </Label>
              <Input
                id="feature-title"
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Issue Title"
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
                <PopoverContent align="start" className="w-full p-0">
                  <Command label="Search artifacts">
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
                              {DOCUMENT_TYPE_LABELS[artifact.type] ??
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
                        <span className="sr-only">Remove {artifact.title}</span>
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
              <Label
                className="font-normal text-muted-foreground text-xs"
                htmlFor="feature-priority"
              >
                Priority
              </Label>
              <Select
                onValueChange={(v: Priority) => setPriority(v)}
                value={priority}
              >
                <SelectTrigger id="feature-priority">
                  <SelectValue placeholder="Not Set" />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_VALUES_LOWEST_FIRST.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PRIORITY_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label
                className="font-normal text-muted-foreground text-xs"
                htmlFor="feature-status"
              >
                Status
              </Label>
              <Select
                onValueChange={(v: IssueStatus) => setSelectedStatus(v)}
                value={status}
              >
                <SelectTrigger id="feature-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ISSUE_STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {issueStatusLabels[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button
              disabled={isSubmitting}
              onClick={handleClose}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={!(title.trim() && selectedProjectId) || isSubmitting}
              type="submit"
            >
              {isSubmitting ? (
                <>
                  <LoaderIcon className="h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Issue"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
