import { cn } from "@repo/design-system/lib/utils";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  MessageSquare,
} from "lucide-react";
import { MessageContent } from "@/components/engineer/chat/MessageContent";
import {
  parseFindingTitle,
  type ReviewFinding,
} from "@/lib/engineer/codex-review-parser";
import { severityToPriority } from "./constants";
import { PriorityBadge } from "./PriorityBadge";
import { SeverityIcon } from "./SeverityIcon";

type FindingCardProps = {
  finding: ReviewFinding;
  idx: number;
  isDismissed: boolean;
  isExpanded: boolean;
  isSelected: boolean;
  chatMode: boolean;
  onToggleExpand: (idx: number) => void;
  onToggleDismiss: (idx: number) => void;
  onOpenChat: (idx: number) => void;
  onSelectFinding: (idx: number) => void;
};

export function FindingCard({
  finding,
  idx,
  isDismissed,
  isExpanded: isFindingExpanded,
  isSelected,
  chatMode,
  onToggleExpand,
  onToggleDismiss,
  onOpenChat,
  onSelectFinding,
}: Readonly<FindingCardProps>) {
  const { title, description } = parseFindingTitle(finding.message);
  const humanized = finding.humanizedBody?.trim() || undefined;
  const hasDetails =
    !isDismissed && (!!humanized || !!description || !!finding.suggestion);
  const displayPriority =
    finding.priority || severityToPriority(finding.severity);

  return (
    <div
      className={cn(
        "relative rounded-lg border bg-card text-card-foreground",
        isDismissed && "opacity-50",
        isSelected && "border-l-2 border-l-primary bg-muted/30"
      )}
      key={`${finding.severity}-${finding.file ?? ""}-${finding.line ?? ""}-${title}`}
    >
      <FindingCardButton
        chatMode={chatMode}
        displayPriority={displayPriority}
        finding={finding}
        hasDetails={hasDetails}
        idx={idx}
        isDismissed={isDismissed}
        isFindingExpanded={isFindingExpanded}
        onOpenChat={onOpenChat}
        onSelectFinding={onSelectFinding}
        onToggleDismiss={onToggleDismiss}
        onToggleExpand={onToggleExpand}
        title={title}
      />
      {isFindingExpanded && humanized && (
        <div className="mr-3 mb-3 ml-12 text-muted-foreground text-xs leading-relaxed">
          <MessageContent content={humanized} />
        </div>
      )}
      {isFindingExpanded && !humanized && (
        <div className="mr-3 mb-3 ml-12 space-y-2">
          <p className="font-semibold text-sm">{title}</p>
          {description && (
            <div className="text-muted-foreground text-xs leading-relaxed">
              <MessageContent content={description} />
            </div>
          )}
        </div>
      )}
      {isFindingExpanded && !humanized && finding.suggestion && (
        <div className="ml-12 border-muted border-l-2 px-3 pb-3 pl-3 text-muted-foreground text-xs italic">
          {finding.suggestion}
        </div>
      )}
    </div>
  );
}

type FindingCardButtonProps = {
  chatMode: boolean;
  isDismissed: boolean;
  hasDetails: boolean;
  isFindingExpanded: boolean;
  idx: number;
  finding: ReviewFinding;
  title: string;
  displayPriority: string;
  onToggleExpand: (idx: number) => void;
  onToggleDismiss: (idx: number) => void;
  onOpenChat: (idx: number) => void;
  onSelectFinding: (idx: number) => void;
};

function FindingCardButton({
  chatMode,
  isDismissed,
  hasDetails,
  isFindingExpanded,
  idx,
  finding,
  title,
  displayPriority,
  onToggleExpand,
  onToggleDismiss,
  onOpenChat,
  onSelectFinding,
}: Readonly<FindingCardButtonProps>) {
  const handleClick = () => {
    if (chatMode) {
      onSelectFinding(idx);
    } else if (!isDismissed && hasDetails) {
      onToggleExpand(idx);
    }
  };

  return (
    <button
      className={cn(
        "flex w-full items-start gap-2 p-3 text-left",
        (hasDetails || chatMode) &&
          "cursor-pointer rounded-lg transition-colors hover:bg-muted/50"
      )}
      onClick={handleClick}
      type="button"
    >
      {!chatMode &&
        hasDetails &&
        (isFindingExpanded ? (
          <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        ))}
      <SeverityIcon severity={finding.severity} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <PriorityBadge priority={displayPriority} />
          <p className="truncate font-medium text-sm">{title}</p>
        </div>
        {finding.file && (
          <code className="font-mono text-muted-foreground text-xs">
            {finding.file}
            {finding.line ? `:${finding.line}` : ""}
          </code>
        )}
      </div>
      <FindingCardActions
        chatMode={chatMode}
        idx={idx}
        isDismissed={isDismissed}
        onOpenChat={onOpenChat}
        onToggleDismiss={onToggleDismiss}
      />
    </button>
  );
}

type FindingCardActionsProps = {
  chatMode: boolean;
  isDismissed: boolean;
  idx: number;
  onToggleDismiss: (idx: number) => void;
  onOpenChat: (idx: number) => void;
};

function FindingCardActions({
  chatMode,
  isDismissed,
  idx,
  onToggleDismiss,
  onOpenChat,
}: Readonly<FindingCardActionsProps>) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {!(chatMode || isDismissed) && (
        <span
          className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
          onClick={(e) => {
            e.stopPropagation();
            onOpenChat(idx);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              e.preventDefault();
              onOpenChat(idx);
            }
          }}
          role="button"
          tabIndex={0}
          title="Discuss this finding with Claude"
        >
          <MessageSquare className="size-3.5" />
        </span>
      )}
      <span
        className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onClick={(e) => {
          e.stopPropagation();
          onToggleDismiss(idx);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            e.preventDefault();
            onToggleDismiss(idx);
          }
        }}
        role="button"
        tabIndex={0}
        title={isDismissed ? "Reopen finding" : "Dismiss finding"}
      >
        {isDismissed ? (
          <Eye className="size-3.5" />
        ) : (
          <EyeOff className="size-3.5" />
        )}
      </span>
    </div>
  );
}
