"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  Brain,
  FolderOpen,
  GitPullRequest,
  Moon,
  MoreVertical,
  Sun,
} from "lucide-react";
import { useState } from "react";
import { PRBrowserDialog } from "@/components/engineer/PRBrowserDialog";
import { RunViewerDialog } from "@/components/engineer/run-viewer/RunViewerDialog";
import { useThemeContext } from "@/components/engineer/ThemeProvider";
import { useFeatureSeen } from "@/hooks/engineer/use-feature-seen";

type HeaderOverflowMenuProps = {
  onOpenLearnings?: () => void;
  isProcessingLearnings?: boolean;
};

export function HeaderOverflowMenu({
  onOpenLearnings,
  isProcessingLearnings,
}: Readonly<HeaderOverflowMenuProps> = {}) {
  const { theme, toggleTheme } = useThemeContext();
  const { seen: prBrowserSeen, markSeen: markPRBrowserSeen } =
    useFeatureSeen("pr-browser");
  const [runViewerOpen, setRunViewerOpen] = useState(false);
  const [prBrowserOpen, setPRBrowserOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="More options"
            className="relative flex size-10 cursor-pointer items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-300 ease-out hover:scale-105 hover:border-primary/30 hover:text-primary hover:shadow-md focus:outline-none focus-visible:border-transparent focus-visible:ring-[3px] focus-visible:ring-primary/50 active:scale-95"
          >
            <MoreVertical className="size-[18px]" strokeWidth={1.5} />
            {!prBrowserSeen && (
              <span className="absolute -top-0.5 -right-0.5 size-2 animate-new-feature-pulse rounded-full bg-emerald-400" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className="cursor-pointer" onClick={toggleTheme}>
            {theme === "dark" ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </DropdownMenuItem>
          {onOpenLearnings && (
            <DropdownMenuItem
              className="cursor-pointer"
              onClick={onOpenLearnings}
            >
              <span className="relative">
                <Brain className="size-4" />
                {isProcessingLearnings && (
                  <span className="absolute -top-0.5 -right-0.5 size-2 animate-ping rounded-full bg-primary" />
                )}
              </span>{" "}
              Learnings
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => setRunViewerOpen(true)}
          >
            <FolderOpen className="size-4" />
            View Run...
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => {
              markPRBrowserSeen();
              setPRBrowserOpen(true);
            }}
          >
            <span className="relative">
              <GitPullRequest className="size-4" />
              {!prBrowserSeen && (
                <span className="absolute -top-0.5 -right-0.5 size-2 animate-new-feature-pulse rounded-full bg-emerald-400" />
              )}
            </span>{" "}
            Pull Requests
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RunViewerDialog onOpenChange={setRunViewerOpen} open={runViewerOpen} />
      <PRBrowserDialog onOpenChange={setPRBrowserOpen} open={prBrowserOpen} />
    </>
  );
}
