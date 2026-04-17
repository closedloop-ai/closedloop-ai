"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { cn } from "@repo/design-system/lib/utils";
import { Search } from "lucide-react";
import { useState } from "react";
import {
  CLAUDE_MODELS,
  DEFAULT_CODEX_MODEL,
  LOCAL_STORAGE_KEYS,
  MODELS,
  REASONING_LEVELS,
} from "@/components/engineer/codex-review/constants";

export type ReviewConfig = {
  instructions: string;
  model: string;
  reasoningEffort: string;
  reviewMode: "uncommitted" | "base";
  provider: "claude" | "codex";
  useBaseRepo?: boolean;
};

type CodexReviewSettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultReviewMode?: "uncommitted" | "base";
  onStartReview: (config: ReviewConfig) => void;
};

export function CodexReviewSettingsDialog({
  open,
  onOpenChange,
  defaultReviewMode = "uncommitted",
  onStartReview,
}: Readonly<CodexReviewSettingsDialogProps>) {
  const [provider, setProvider] = useState<"claude" | "codex">(() => {
    if (globalThis.window === undefined) {
      return "claude";
    }
    return (
      (localStorage.getItem(LOCAL_STORAGE_KEYS.provider) as
        | "claude"
        | "codex") || "claude"
    );
  });
  const [model, setModel] = useState(() => {
    if (globalThis.window === undefined) {
      return "claude-opus-4-6";
    }
    return localStorage.getItem(LOCAL_STORAGE_KEYS.model) || "claude-opus-4-6";
  });
  const [reasoningEffort, setReasoningEffort] = useState(() => {
    if (globalThis.window === undefined) {
      return "medium";
    }
    return localStorage.getItem(LOCAL_STORAGE_KEYS.reasoning) || "medium";
  });
  const [reviewMode, setReviewMode] = useState<"uncommitted" | "base">(
    defaultReviewMode
  );
  const [useBaseRepo, setUseBaseRepo] = useState(false);

  const modelList = provider === "claude" ? CLAUDE_MODELS : MODELS;

  const handleProviderChange = (p: "claude" | "codex") => {
    setProvider(p);
    // Reset model to stable default for the new provider
    const newDefault =
      p === "claude" ? CLAUDE_MODELS[0].value : DEFAULT_CODEX_MODEL;
    setModel(newDefault);
  };

  const handleStart = () => {
    // Persist preferences
    if (globalThis.window !== undefined) {
      localStorage.setItem(LOCAL_STORAGE_KEYS.model, model);
      localStorage.setItem(LOCAL_STORAGE_KEYS.reasoning, reasoningEffort);
      localStorage.setItem(LOCAL_STORAGE_KEYS.provider, provider);
    }
    onStartReview({
      instructions: "",
      model,
      reasoningEffort,
      reviewMode,
      provider,
      useBaseRepo: provider === "claude" ? useBaseRepo : undefined,
    });
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Search className="size-5" />
            Review Settings
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Provider toggle */}
          <div className="space-y-2">
            <Label>Provider</Label>
            <div className="flex gap-0.5 rounded-md bg-muted p-0.5">
              <button
                className={cn(
                  "flex-1 cursor-pointer rounded px-3 py-1.5 font-medium text-sm transition-colors",
                  provider === "claude"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => handleProviderChange("claude")}
                type="button"
              >
                Claude
              </button>
              <button
                className={cn(
                  "flex-1 cursor-pointer rounded px-3 py-1.5 font-medium text-sm transition-colors",
                  provider === "codex"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => handleProviderChange("codex")}
                type="button"
              >
                Codex
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Review Mode</Label>
            <Select
              onValueChange={(v: "uncommitted" | "base") => setReviewMode(v)}
              value={reviewMode}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="uncommitted">Uncommitted changes</SelectItem>
                <SelectItem value="base">Against main branch</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {provider === "claude" && (
            <label
              aria-label="Use base repo (skip worktree)"
              className="flex cursor-pointer items-start gap-2"
            >
              <input
                checked={useBaseRepo}
                className="mt-0.5 accent-emerald-600"
                onChange={(e) => setUseBaseRepo(e.target.checked)}
                type="checkbox"
              />
              <div>
                <span className="font-medium text-sm">
                  Use base repo (skip worktree)
                </span>
                <p className="text-muted-foreground text-xs">
                  Runs the review in your local checkout. You must have the
                  correct branch checked out.
                </p>
              </div>
            </label>
          )}

          <div
            className={cn(
              "grid gap-4",
              provider === "codex" ? "grid-cols-2" : "grid-cols-1"
            )}
          >
            <div className="space-y-2">
              <Label>Model</Label>
              <Select onValueChange={setModel} value={model}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modelList.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {provider === "claude" && (
                <p className="text-muted-foreground text-xs">
                  With /code-review:start, this model runs the orchestrator only
                  — review agents use their own routing.
                </p>
              )}
            </div>
            {provider === "codex" && (
              <div className="space-y-2">
                <Label>Reasoning Level</Label>
                <Select
                  onValueChange={setReasoningEffort}
                  value={reasoningEffort}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REASONING_LEVELS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <Button className="w-full" onClick={handleStart}>
            <Search className="mr-2 size-4" />
            Start Review
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
