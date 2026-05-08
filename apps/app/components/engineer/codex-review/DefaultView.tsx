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
import { Textarea } from "@repo/design-system/components/ui/textarea";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  MessagesSquare,
  Search,
  Square,
} from "lucide-react";
import { useEffect, useRef } from "react";
import type { ReviewFindings } from "@/lib/engineer/codex-review-parser";
import { MODELS, REASONING_LEVELS } from "./constants";
import { FindingsPanel } from "./FindingsPanel";

type DefaultViewProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticketId: string;
  // Config state
  instructions: string;
  onInstructionsChange: (value: string) => void;
  model: string;
  onModelChange: (value: string) => void;
  reasoningEffort: string;
  onReasoningEffortChange: (value: string) => void;
  reviewMode: "uncommitted" | "base";
  onReviewModeChange: (value: "uncommitted" | "base") => void;
  // Review state
  isStarting: boolean;
  isRunning: boolean;
  isCompleted: boolean;
  showConfig: boolean;
  localOutput: string;
  outputExpanded: boolean;
  onToggleOutput: () => void;
  findings: ReviewFindings | null;
  // Findings state
  dismissedFindings: Set<number>;
  expandedFindings: Set<number>;
  onToggleFindingExpand: (idx: number) => void;
  onToggleFindingDismiss: (idx: number) => void;
  onOpenFindingChat: (idx: number) => void;
  // Handlers
  onStartReview: () => void;
  onStopReview: () => void;
  onDiscussFindings: () => void;
  onDone: () => Promise<void>;
  onStartNewReview: () => Promise<void>;
  // Review status config
  reviewStatusConfig?: {
    model: string;
    reasoningEffort: string;
    reviewMode: string;
  };
};

export function DefaultView({
  open,
  onOpenChange,
  ticketId,
  instructions,
  onInstructionsChange,
  model,
  onModelChange,
  reasoningEffort,
  onReasoningEffortChange,
  reviewMode,
  onReviewModeChange,
  isStarting,
  isRunning,
  isCompleted,
  showConfig,
  localOutput,
  outputExpanded,
  onToggleOutput,
  findings,
  dismissedFindings,
  expandedFindings,
  onToggleFindingExpand,
  onToggleFindingDismiss,
  onOpenFindingChat,
  onStartReview,
  onStopReview,
  onDiscussFindings,
  onDone,
  onStartNewReview,
  reviewStatusConfig,
}: Readonly<DefaultViewProps>) {
  const outputRef = useRef<HTMLPreElement>(null);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current && outputExpanded) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [outputExpanded]);

  const showConfigForm =
    !(isStarting || isRunning) && (!isCompleted || showConfig);
  const allDismissed =
    findings &&
    findings.findings.length > 0 &&
    dismissedFindings.size >= findings.findings.length;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Search className="size-5" />
            Code Review with Codex - {ticketId}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 space-y-6 overflow-y-auto">
          {showConfigForm && (
            <ConfigForm
              instructions={instructions}
              isStarting={isStarting}
              model={model}
              onInstructionsChange={onInstructionsChange}
              onModelChange={onModelChange}
              onReasoningEffortChange={onReasoningEffortChange}
              onReviewModeChange={onReviewModeChange}
              onStartReview={onStartReview}
              reasoningEffort={reasoningEffort}
              reviewMode={reviewMode}
            />
          )}

          {isRunning && (
            <RunningState
              onStopReview={onStopReview}
              reviewStatusConfig={reviewStatusConfig}
            />
          )}

          {(localOutput || isRunning) && (
            <OutputSection
              localOutput={localOutput}
              onToggleOutput={onToggleOutput}
              outputExpanded={outputExpanded}
              outputRef={outputRef}
            />
          )}

          {findings && (
            <div className="space-y-4">
              <FindingsPanel
                chatMode={false}
                dismissedFindings={dismissedFindings}
                expandedFindings={expandedFindings}
                findings={findings}
                onOpenChat={onOpenFindingChat}
                onSelectFinding={() => {}}
                onToggleDismiss={onToggleFindingDismiss}
                onToggleExpand={onToggleFindingExpand}
                selectedFindingIndex={null}
              />

              {allDismissed ? (
                <Button className="w-full" onClick={onDone}>
                  <CheckCircle2 className="mr-2 size-4" />
                  Done
                </Button>
              ) : (
                <Button
                  className="w-full"
                  onClick={onDiscussFindings}
                  variant="outline"
                >
                  <MessagesSquare className="mr-2 size-4" />
                  Discuss All Findings with Claude
                </Button>
              )}
            </div>
          )}

          {isCompleted && !findings && localOutput && (
            <div className="py-4 text-center text-muted-foreground text-sm">
              Parsing review output...
            </div>
          )}

          {isCompleted && !showConfig && (
            <Button
              className="w-full"
              onClick={onStartNewReview}
              variant="ghost"
            >
              Start New Review
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// --- Sub-components ---

type ConfigFormProps = {
  instructions: string;
  onInstructionsChange: (value: string) => void;
  model: string;
  onModelChange: (value: string) => void;
  reasoningEffort: string;
  onReasoningEffortChange: (value: string) => void;
  reviewMode: "uncommitted" | "base";
  onReviewModeChange: (value: "uncommitted" | "base") => void;
  isStarting: boolean;
  onStartReview: () => void;
};

function ConfigForm({
  instructions,
  onInstructionsChange,
  model,
  onModelChange,
  reasoningEffort,
  onReasoningEffortChange,
  reviewMode,
  onReviewModeChange,
  isStarting,
  onStartReview,
}: Readonly<ConfigFormProps>) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="instructions">Instructions (optional)</Label>
        <Textarea
          id="instructions"
          onChange={(e) => onInstructionsChange(e.target.value)}
          placeholder="Focus on security issues and error handling..."
          rows={3}
          value={instructions}
        />
      </div>

      <div className="space-y-2">
        <Label>Review Mode</Label>
        <Select
          onValueChange={(v: "uncommitted" | "base") => onReviewModeChange(v)}
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

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Model</Label>
          <Select onValueChange={onModelChange} value={model}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODELS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Reasoning Level</Label>
          <Select
            onValueChange={onReasoningEffortChange}
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
      </div>

      <Button className="w-full" disabled={isStarting} onClick={onStartReview}>
        {isStarting ? (
          <>
            <Loader2 className="mr-2 size-4 animate-spin" />
            Starting Review...
          </>
        ) : (
          <>
            <Search className="mr-2 size-4" />
            Start Review
          </>
        )}
      </Button>
    </div>
  );
}

type RunningStateProps = {
  onStopReview: () => void;
  reviewStatusConfig?: {
    model: string;
    reasoningEffort: string;
    reviewMode: string;
  };
};

function RunningState({
  onStopReview,
  reviewStatusConfig,
}: Readonly<RunningStateProps>) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-primary">
          <Loader2 className="size-4 animate-spin" />
          <span className="font-medium text-sm">Running code review...</span>
        </div>
        <Button onClick={onStopReview} size="sm" variant="outline">
          <Square className="mr-2 size-3" />
          Stop
        </Button>
      </div>
      {reviewStatusConfig && (
        <div className="text-muted-foreground text-xs">
          Model: {reviewStatusConfig.model} | Reasoning:{" "}
          {reviewStatusConfig.reasoningEffort} | Mode:{" "}
          {reviewStatusConfig.reviewMode}
        </div>
      )}
    </div>
  );
}

type OutputSectionProps = {
  localOutput: string;
  outputExpanded: boolean;
  onToggleOutput: () => void;
  outputRef: React.RefObject<HTMLPreElement | null>;
};

function OutputSection({
  localOutput,
  outputExpanded,
  onToggleOutput,
  outputRef,
}: Readonly<OutputSectionProps>) {
  return (
    <div className="space-y-2">
      <button
        className="flex items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground"
        onClick={onToggleOutput}
        type="button"
      >
        {outputExpanded ? (
          <ChevronDown className="size-4" />
        ) : (
          <ChevronRight className="size-4" />
        )}
        Raw Output
        {localOutput && (
          <span className="text-xs">
            ({Math.round(localOutput.length / 1024)}KB)
          </span>
        )}
      </button>
      {outputExpanded && (
        <pre
          className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-4 font-mono text-xs"
          ref={outputRef}
        >
          {localOutput || "Waiting for output..."}
        </pre>
      )}
    </div>
  );
}
