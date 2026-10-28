"use client";

import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import type { ReactNode } from "react";
import { SessionStatusGroupIcon } from "../components/sessions/session-group-icons";
import {
  buildSessionGroups,
  type SessionGroupBy,
  SessionGroupBy as SessionGroupByValue,
} from "../lib/session-grouping";
import { buildUniversalSessionStatusBands } from "../lib/universal-session-status-grouping";

/** Selects legacy or canonical Session band labels and marks. */
export function useSessionGroups(
  rows: readonly SessionTableRow[],
  groupBy: SessionGroupBy
): SessionPresentationGroup[] | undefined {
  const champion = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  if (!(champion && groupBy === SessionGroupByValue.Status)) {
    return buildSessionGroups(rows, groupBy);
  }
  return buildUniversalSessionStatusBands(rows).map((group) => {
    const firstRow = group.items[0];
    return {
      items: group.items,
      key: group.key,
      icon: (
        <SessionStatusGroupIcon
          rawStatus={firstRow.rawStatus}
          status={firstRow.status}
        />
      ),
      label: group.label,
    };
  });
}

type SessionPresentationGroup = NonNullable<
  ReturnType<typeof buildSessionGroups>
>[number] & { icon?: ReactNode };
