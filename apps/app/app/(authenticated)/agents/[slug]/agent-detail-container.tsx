"use client";

import type { AgentVersionSummary } from "@repo/api/src/types/agent";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/design-system/components/ui/alert-dialog";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Switch } from "@repo/design-system/components/ui/switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import {
  ArrowLeftIcon,
  Loader2Icon,
  SaveIcon,
  Trash2Icon,
  UndoIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  useAgent,
  useAgentVersion,
  useAgentVersions,
  useDeleteAgent,
  useUpdateAgent,
} from "@/hooks/queries/use-agents";
import { formatRelativeTime } from "@/lib/date-utils";
import { getUserDisplayName } from "@/lib/user-utils";

type AgentDetailContainerProps = {
  slug: string;
};

export function AgentDetailContainer({ slug }: AgentDetailContainerProps) {
  const router = useRouter();
  const { data: agent, isLoading, error } = useAgent(slug);
  const updateAgent = useUpdateAgent(slug);
  const deleteAgent = useDeleteAgent();

  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("prompt");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameChangeNote, setNameChangeNote] = useState("");

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 text-destructive">
        {error?.message ?? "Agent not found"}
      </div>
    );
  }

  const handleSavePrompt = () => {
    if (!changeNote.trim()) {
      toast.error("Please describe your changes");
      return;
    }
    updateAgent.mutate(
      {
        prompt: promptDraft,
        changeNote: changeNote.trim(),
      },
      {
        onSuccess: () => {
          toast.success("Agent prompt updated");
          setEditingPrompt(false);
          setChangeNote("");
        },
      }
    );
  };

  const handleSaveDescription = () => {
    updateAgent.mutate(
      { description: descriptionDraft },
      {
        onSuccess: () => {
          toast.success("Description updated");
          setEditingDescription(false);
        },
      }
    );
  };

  const handleDelete = () => {
    deleteAgent.mutate(agent.slug, {
      onSuccess: () => {
        toast.success("Agent deleted");
        router.push("/agents");
      },
    });
  };

  const handleSaveName = () => {
    if (!nameChangeNote.trim()) {
      toast.error("Please describe why you're renaming this agent");
      return;
    }
    updateAgent.mutate(
      {
        name: nameDraft.trim(),
        changeNote: nameChangeNote.trim(),
      },
      {
        onSuccess: () => {
          toast.success("Agent renamed");
          setEditingName(false);
          setNameChangeNote("");
        },
      }
    );
  };

  const handleToggleEnabled = (checked: boolean) => {
    updateAgent.mutate(
      { enabled: checked },
      {
        onSuccess: () => {
          toast.success(`Agent ${checked ? "enabled" : "disabled"}`);
        },
      }
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <Button aria-label="Back to agents" asChild size="sm" variant="ghost">
            <Link href="/agents">
              <ArrowLeftIcon className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            {editingName ? (
              <div className="space-y-2">
                <Input
                  className="font-bold text-2xl"
                  onChange={(e) => setNameDraft(e.target.value)}
                  value={nameDraft}
                />
                <Input
                  onChange={(e) => setNameChangeNote(e.target.value)}
                  placeholder="Why are you renaming this agent?"
                  value={nameChangeNote}
                />
                <div className="flex items-center gap-2">
                  <Button
                    disabled={!nameDraft.trim() || updateAgent.isPending}
                    onClick={handleSaveName}
                    size="sm"
                  >
                    Save
                  </Button>
                  <Button
                    onClick={() => {
                      setEditingName(false);
                      setNameChangeNote("");
                    }}
                    size="sm"
                    variant="outline"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <button
                className="cursor-pointer bg-transparent p-0 font-bold text-2xl text-foreground hover:text-primary"
                onClick={() => {
                  setNameDraft(agent.name);
                  setEditingName(true);
                }}
                type="button"
              >
                {agent.name}
              </button>
            )}
            <div className="mt-1 flex items-center gap-2">
              <Badge variant="secondary">{agent.role}</Badge>
              <span className="font-mono text-muted-foreground text-sm">
                v{agent.currentVersion}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Label className="text-sm" htmlFor="agent-enabled">
              {agent.enabled ? "Enabled" : "Disabled"}
            </Label>
            <Switch
              checked={agent.enabled}
              id="agent-enabled"
              onCheckedChange={handleToggleEnabled}
            />
          </div>
          <Button
            onClick={() => setDeleteDialogOpen(true)}
            size="sm"
            variant="destructive"
          >
            <Trash2Icon className="h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      <Tabs defaultValue="prompt" onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="versions">Versions</TabsTrigger>
        </TabsList>

        <TabsContent className="mt-4" value="prompt">
          <PromptTab
            changeNote={changeNote}
            editing={editingPrompt}
            isPending={updateAgent.isPending}
            onCancel={() => {
              setEditingPrompt(false);
              setChangeNote("");
            }}
            onChangeNoteChange={setChangeNote}
            onEdit={() => {
              setPromptDraft(agent.prompt);
              setEditingPrompt(true);
            }}
            onPromptChange={setPromptDraft}
            onSave={handleSavePrompt}
            prompt={agent.prompt}
            promptDraft={promptDraft}
          />
        </TabsContent>

        <TabsContent className="mt-4" value="details">
          <DetailsTab
            agent={agent}
            descriptionDraft={descriptionDraft}
            editingDescription={editingDescription}
            isPending={updateAgent.isPending}
            onCancelDescription={() => setEditingDescription(false)}
            onDescriptionChange={setDescriptionDraft}
            onEditDescription={() => {
              setDescriptionDraft(agent.description ?? "");
              setEditingDescription(true);
            }}
            onSaveDescription={handleSaveDescription}
          />
        </TabsContent>

        <TabsContent className="mt-4" value="versions">
          <VersionsTab active={activeTab === "versions"} slug={slug} />
        </TabsContent>
      </Tabs>

      <AlertDialog onOpenChange={setDeleteDialogOpen} open={deleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this agent?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{agent.name}&rdquo; and all
              its version history. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              Delete Agent
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type PromptTabProps = {
  prompt: string;
  promptDraft: string;
  editing: boolean;
  changeNote: string;
  isPending: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onPromptChange: (value: string) => void;
  onChangeNoteChange: (value: string) => void;
};

function PromptTab({
  prompt,
  promptDraft,
  editing,
  changeNote,
  isPending,
  onEdit,
  onCancel,
  onSave,
  onPromptChange,
  onChangeNoteChange,
}: PromptTabProps) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Agent Prompt</CardTitle>
        {editing ? (
          <div className="flex items-center gap-2">
            <Button onClick={onCancel} size="sm" variant="outline">
              Cancel
            </Button>
            <Button disabled={isPending} onClick={onSave} size="sm">
              {isPending ? (
                <Loader2Icon className="h-4 w-4 animate-spin" />
              ) : (
                <SaveIcon className="h-4 w-4" />
              )}
              Save
            </Button>
          </div>
        ) : (
          <Button onClick={onEdit} size="sm" variant="outline">
            Edit
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {editing ? (
          <>
            <Textarea
              className="min-h-[400px] font-mono text-sm"
              onChange={(e) => onPromptChange(e.target.value)}
              value={promptDraft}
            />
            <div className="grid gap-2">
              <Label htmlFor="change-note">Describe your changes</Label>
              <Input
                id="change-note"
                onChange={(e) => onChangeNoteChange(e.target.value)}
                placeholder="What did you change and why?"
                value={changeNote}
              />
            </div>
          </>
        ) : (
          <pre className="max-h-[600px] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-4 font-mono text-sm">
            {prompt}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

type DetailsTabProps = {
  agent: {
    description: string | null;
    sourceRepo: string;
    createdBy: {
      id: string;
      firstName: string | null;
      lastName: string | null;
    };
    createdAt: Date;
    updatedAt: Date;
  };
  editingDescription: boolean;
  descriptionDraft: string;
  isPending: boolean;
  onEditDescription: () => void;
  onCancelDescription: () => void;
  onSaveDescription: () => void;
  onDescriptionChange: (value: string) => void;
};

function DetailsTab({
  agent,
  editingDescription,
  descriptionDraft,
  isPending,
  onEditDescription,
  onCancelDescription,
  onSaveDescription,
  onDescriptionChange,
}: DetailsTabProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent Details</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-4">
          <dt className="font-medium text-muted-foreground text-sm">
            Description
          </dt>
          <dd>
            {editingDescription ? (
              <div className="flex items-center gap-2">
                <Input
                  className="flex-1"
                  onChange={(e) => onDescriptionChange(e.target.value)}
                  value={descriptionDraft}
                />
                <Button
                  onClick={onCancelDescription}
                  size="sm"
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  disabled={isPending}
                  onClick={onSaveDescription}
                  size="sm"
                >
                  Save
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-sm">
                  {agent.description || "No description"}
                </span>
                <Button onClick={onEditDescription} size="sm" variant="ghost">
                  Edit
                </Button>
              </div>
            )}
          </dd>

          <dt className="font-medium text-muted-foreground text-sm">
            Source Repo
          </dt>
          <dd className="text-sm">{agent.sourceRepo || "Org-wide"}</dd>

          <dt className="font-medium text-muted-foreground text-sm">
            Created By
          </dt>
          <dd className="text-sm">{getUserDisplayName(agent.createdBy)}</dd>

          <dt className="font-medium text-muted-foreground text-sm">Created</dt>
          <dd className="text-sm">{formatRelativeTime(agent.createdAt)}</dd>

          <dt className="font-medium text-muted-foreground text-sm">Updated</dt>
          <dd className="text-sm">{formatRelativeTime(agent.updatedAt)}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}

function VersionsTab({
  slug,
  active,
}: Readonly<{ slug: string; active: boolean }>) {
  const { data, isLoading, error } = useAgentVersions(slug, {
    enabled: active,
  });
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 text-destructive">
        {error.message ?? "Failed to load version history"}
      </div>
    );
  }

  const versions = data?.versions ?? [];

  if (versions.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No version history available.
        </CardContent>
      </Card>
    );
  }

  if (viewingVersion !== null) {
    return (
      <VersionDetail
        onBack={() => setViewingVersion(null)}
        slug={slug}
        version={viewingVersion}
      />
    );
  }

  return (
    <div className="space-y-2">
      {versions.map((v) => (
        <VersionRow
          key={v.id}
          onView={() => setViewingVersion(v.version)}
          version={v}
        />
      ))}
    </div>
  );
}

function VersionRow({
  version,
  onView,
}: Readonly<{
  version: AgentVersionSummary;
  onView: () => void;
}>) {
  return (
    <div className="flex items-center justify-between rounded-md border p-3">
      <div className="flex items-center gap-3">
        <Badge variant="outline">v{version.version}</Badge>
        <div>
          <p className="font-medium text-sm">{version.name}</p>
          <p className="text-muted-foreground text-xs">
            {version.changeNote ?? "No change note"} &middot;{" "}
            {getUserDisplayName(version.changedBy)} &middot;{" "}
            {formatRelativeTime(version.createdAt)}
          </p>
        </div>
      </div>
      <Button onClick={onView} size="sm" variant="ghost">
        View
      </Button>
    </div>
  );
}

function VersionDetail({
  slug,
  version,
  onBack,
}: Readonly<{
  slug: string;
  version: number;
  onBack: () => void;
}>) {
  const {
    data: versionDetail,
    isLoading,
    error,
  } = useAgentVersion(slug, version);
  const updateAgent = useUpdateAgent(slug);

  const handleRestore = () => {
    if (!versionDetail) {
      return;
    }
    updateAgent.mutate(
      {
        name: versionDetail.name,
        prompt: versionDetail.prompt,
        changeNote: `Restored from v${version}`,
      },
      {
        onSuccess: () => {
          toast.success(`Restored from v${version}`);
          onBack();
        },
      }
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !versionDetail) {
    return (
      <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 text-destructive">
        {error?.message ?? "Failed to load version"}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            aria-label="Back to version list"
            onClick={onBack}
            size="sm"
            variant="ghost"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </Button>
          <div>
            <CardTitle>Version {version}</CardTitle>
            <p className="text-muted-foreground text-sm">
              {versionDetail.changeNote ?? "No change note"} &middot;{" "}
              {getUserDisplayName(versionDetail.changedBy)} &middot;{" "}
              {formatRelativeTime(versionDetail.createdAt)}
            </p>
          </div>
        </div>
        <Button
          disabled={updateAgent.isPending}
          onClick={handleRestore}
          size="sm"
          variant="outline"
        >
          {updateAgent.isPending ? (
            <Loader2Icon className="h-4 w-4 animate-spin" />
          ) : (
            <UndoIcon className="h-4 w-4" />
          )}
          Restore this version
        </Button>
      </CardHeader>
      <CardContent>
        <pre className="max-h-[600px] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-4 font-mono text-sm">
          {versionDetail.prompt}
        </pre>
      </CardContent>
    </Card>
  );
}
