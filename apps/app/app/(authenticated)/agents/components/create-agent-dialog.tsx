"use client";

import { Button } from "@repo/design-system/components/ui/button";
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
import { toast } from "@repo/design-system/components/ui/sonner";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { LoaderIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useCreateAgent } from "@/hooks/queries/use-agents";

type CreateAgentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CreateAgentDialog({
  open,
  onOpenChange,
}: CreateAgentDialogProps) {
  const router = useRouter();
  const createAgent = useCreateAgent();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");

  const canSubmit = name.trim() && role.trim() && prompt.trim();

  const handleSubmit = () => {
    if (!canSubmit) {
      return;
    }
    createAgent.mutate(
      {
        name: name.trim(),
        role: role.trim(),
        description: description.trim() || undefined,
        prompt: prompt.trim(),
      },
      {
        onSuccess: (agent) => {
          toast.success("Agent created");
          resetForm();
          onOpenChange(false);
          router.push(`/agents/${agent.slug}`);
        },
      }
    );
  };

  const resetForm = () => {
    setName("");
    setRole("");
    setDescription("");
    setPrompt("");
  };

  return (
    <Dialog
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          resetForm();
        }
        onOpenChange(isOpen);
      }}
      open={open}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Agent</DialogTitle>
          <DialogDescription>
            Create a new AI agent for your organization.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              onChange={(e) => setName(e.target.value)}
              placeholder="Frontend Architect"
              value={name}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-role">Role</Label>
            <Input
              id="agent-role"
              onChange={(e) => setRole(e.target.value)}
              placeholder="frontend-architect"
              value={role}
            />
            <p className="text-muted-foreground text-xs">
              Used to generate the agent slug. Use lowercase with hyphens.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-description">Description (optional)</Label>
            <Input
              id="agent-description"
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Specializes in React/Next.js frontend architecture"
              value={description}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-prompt">Prompt</Label>
            <Textarea
              className="min-h-[200px] font-mono text-sm"
              id="agent-prompt"
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="---&#10;name: frontend-architect&#10;description: Specializes in React/Next.js&#10;---&#10;&#10;You are a frontend architecture expert..."
              value={prompt}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => {
              resetForm();
              onOpenChange(false);
            }}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={!canSubmit || createAgent.isPending}
            onClick={handleSubmit}
          >
            {createAgent.isPending ? (
              <LoaderIcon className="h-4 w-4 animate-spin" />
            ) : null}
            Create Agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
