"use client";

import { cn } from "@repo/design-system/lib/utils";
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  LoaderCircleIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { type CiCheck, CiCheckStatus } from "../mock";

type CheckPresentation = {
  Icon: ComponentType<{ className?: string }>;
  iconClassName: string;
  srLabel: string;
  spin?: boolean;
};

const CHECK_PRESENTATION: Record<CiCheckStatus, CheckPresentation> = {
  [CiCheckStatus.Passed]: {
    Icon: CheckCircle2Icon,
    iconClassName: "text-success",
    srLabel: "passed",
  },
  [CiCheckStatus.Running]: {
    Icon: LoaderCircleIcon,
    iconClassName: "text-info",
    srLabel: "running",
    spin: true,
  },
  [CiCheckStatus.Failed]: {
    Icon: XCircleIcon,
    iconClassName: "text-destructive",
    srLabel: "failed",
  },
  [CiCheckStatus.Queued]: {
    Icon: CircleDashedIcon,
    iconClassName: "text-muted-foreground",
    srLabel: "queued",
  },
};

function summarize(checks: CiCheck[]): string {
  const total = checks.length;
  const passed = checks.filter(
    (check) => check.status === CiCheckStatus.Passed
  ).length;
  const failed = checks.filter(
    (check) => check.status === CiCheckStatus.Failed
  ).length;
  if (failed > 0) {
    return `${failed} of ${total} checks failing`;
  }
  if (passed === total) {
    return `All ${total} checks passed`;
  }
  return `${passed} of ${total} checks passed`;
}

/**
 * CI is a workflow of checks, not a conversational session — so it renders as a
 * compact strip on the branch header rather than a fabricated agent turn in the
 * session list. Each check is an icon + name; the leading text summarizes the
 * roll-up without inventing a cost/token meta line CI doesn't have.
 */
export function BranchChecksStrip({ checks }: { checks: CiCheck[] }) {
  if (checks.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-muted-foreground text-xs">
      <span className="font-medium text-foreground">{summarize(checks)}</span>
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {checks.map((check) => {
          const presentation = CHECK_PRESENTATION[check.status];
          const { Icon } = presentation;
          return (
            <li className="flex items-center gap-1.5" key={check.id}>
              <Icon
                className={cn(
                  "size-3.5 shrink-0",
                  presentation.iconClassName,
                  presentation.spin && "animate-spin"
                )}
              />
              <span>{check.name}</span>
              <span className="sr-only"> {presentation.srLabel}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
