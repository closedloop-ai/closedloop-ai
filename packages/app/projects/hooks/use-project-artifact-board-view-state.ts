"use client";

import {
  GridPreferenceGridKey,
  projectGridPreferenceScopeKey,
} from "@repo/api/src/types/grid-preferences";
import type {
  ProjectArtifactBoardUrlAxes,
  ProjectArtifactBoardView,
} from "@repo/api/src/types/project-artifact-board-view";
import { useGridPreferenceRemote } from "@repo/app/shared/hooks/use-grid-preference-remote";
import { useOptionalPersistedState } from "@repo/app/shared/hooks/use-optional-persisted-state";
import { isWithinGridPreferenceValueCap } from "@repo/app/shared/lib/grid-preference-import";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  decodeProjectArtifactBoardView,
  parseProjectArtifactBoardView,
  resolveProjectArtifactBoardView,
  serializeProjectArtifactBoardView,
} from "../lib/project-artifact-board-view-state";

/** Project-isolated local + account board arrangement with URL-first precedence. */
export function useProjectArtifactBoardViewState(input: {
  defaults: ProjectArtifactBoardView;
  projectId: string;
  saved?: ProjectArtifactBoardView | null;
  storageKey: string | null;
  url?: ProjectArtifactBoardUrlAxes & {
    secondaryLaneField?:
      | ProjectArtifactBoardUrlAxes["secondaryLaneField"]
      | null;
  };
}) {
  const { defaults, projectId, saved, storageKey, url } = input;
  const [persisted, setPersisted] = useOptionalPersistedState(
    storageKey,
    defaults,
    parseProjectArtifactBoardView
  );
  const latestPersisted = useRef(persisted);
  latestPersisted.current = persisted;
  const remote = useGridPreferenceRemote({
    gridKey: GridPreferenceGridKey.ProjectArtifacts,
    scopeKey: projectGridPreferenceScopeKey(projectId),
    storageKey,
  });
  const appliedInboundSeq = useRef(0);
  useEffect(() => {
    const inbound = remote.inbound;
    if (!inbound || inbound.seq === appliedInboundSeq.current) {
      return;
    }
    appliedInboundSeq.current = inbound.seq;
    const decoded = decodeSerializedBoardView(inbound.serialized, defaults);
    if (!decoded) {
      return;
    }
    latestPersisted.current = decoded;
    setPersisted(decoded);
  }, [defaults, remote.inbound, setPersisted]);

  const view = useMemo(
    () => resolveProjectArtifactBoardView({ defaults, persisted, saved, url }),
    [defaults, persisted, saved, url]
  );
  const setArrangement = useCallback(
    (
      update: (
        current: ProjectArtifactBoardView["arrangement"]
      ) => ProjectArtifactBoardView["arrangement"]
    ) => {
      const current = latestPersisted.current;
      const candidate = {
        arrangement: update(current.arrangement),
        version: current.version,
      };
      const decoded = decodeProjectArtifactBoardView(candidate, current);
      if (!decoded) {
        return;
      }
      const serialized = serializeProjectArtifactBoardView(decoded);
      if (!isWithinGridPreferenceValueCap(serialized)) {
        return;
      }
      latestPersisted.current = decoded;
      setPersisted(decoded);
      remote.publish(serialized);
    },
    [remote, setPersisted]
  );

  return {
    setArrangement,
    view,
  };
}

function decodeSerializedBoardView(
  serialized: string,
  fallback: ProjectArtifactBoardView
) {
  try {
    return decodeProjectArtifactBoardView(JSON.parse(serialized), fallback);
  } catch {
    return null;
  }
}
