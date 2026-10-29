"use client";

import { toast } from "@repo/design-system/components/ui/sonner";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  genericArtifactCompatibleStatusOptions,
  genericArtifactStatusForSelection,
} from "../../generic-artifact-status";
import type { GenericArtifact } from "../fixtures";
import { applyArtifactBulkMutation } from "./artifact-list-control-adapters";
import type { ArtifactBulkAction, TagDefinition } from "./artifact-list-model";

type ArtifactListBulkActionOptions = Readonly<{
  artifacts: readonly GenericArtifact[];
  favoriteArtifactIds: ReadonlySet<string>;
  selectedArtifactIds: ReadonlySet<string>;
  selectionAnchorId: RefObject<string | null>;
  setArtifacts: Dispatch<SetStateAction<GenericArtifact[]>>;
  setFavoriteArtifactIds: Dispatch<SetStateAction<Set<string>>>;
  setSelectedArtifactIds: Dispatch<SetStateAction<Set<string>>>;
  setTagDefinitions: Dispatch<SetStateAction<TagDefinition[]>>;
  tagDefinitions: readonly TagDefinition[];
}>;

/** Owns mock bulk mutations, compatible status options, receipts, and Undo. */
export function useArtifactListBulkActions({
  artifacts,
  favoriteArtifactIds,
  selectedArtifactIds,
  selectionAnchorId,
  setArtifacts,
  setFavoriteArtifactIds,
  setSelectedArtifactIds,
  setTagDefinitions,
  tagDefinitions,
}: ArtifactListBulkActionOptions) {
  const applyBulkAction = (action: ArtifactBulkAction, value?: string) => {
    const selectedIds = new Set(selectedArtifactIds);
    const previousArtifacts = artifacts;
    const previousFavorites = new Set(favoriteArtifactIds);
    const previousTagDefinitions = tagDefinitions;
    const count = selectedIds.size;
    const actionLabel = {
      "add-tag": "Tag added",
      "add-to-project": "Added to project",
      "assign-owner": "Owner assigned",
      favorite: "Added to favorites",
    }[action];

    if (action === "favorite") {
      setFavoriteArtifactIds((current) => {
        const next = new Set(current);
        for (const id of selectedIds) {
          next.add(id);
        }
        return next;
      });
    } else {
      setArtifacts((current) =>
        current.map((artifact) =>
          selectedIds.has(artifact.id)
            ? applyArtifactBulkMutation(artifact, action, value)
            : artifact
        )
      );
      if (action === "add-tag") {
        setTagDefinitions((current) =>
          !value || current.some((tag) => tag.label === value)
            ? current
            : [...current, { color: "blue", label: value }]
        );
      }
    }

    clearSelection(setSelectedArtifactIds, selectionAnchorId);
    toast.success(
      `${actionLabel} for ${count} artifact${count === 1 ? "" : "s"}`,
      {
        action: {
          label: "Undo",
          onClick: () => {
            setArtifacts([...previousArtifacts]);
            setFavoriteArtifactIds(previousFavorites);
            setTagDefinitions([...previousTagDefinitions]);
          },
        },
      }
    );
  };
  const selectedArtifacts = artifacts.filter((artifact) =>
    selectedArtifactIds.has(artifact.id)
  );
  const bulkStatusOptions =
    genericArtifactCompatibleStatusOptions(selectedArtifacts);
  const applyBulkStatus = (key: string) => {
    const updates = resolveArtifactBulkStatusUpdates(selectedArtifacts, key);
    if (updates === null || updates.length === 0) {
      return;
    }
    const previousArtifacts = artifacts;
    const statusById = new Map(
      updates.map((entry) => [entry.artifactId, entry.status] as const)
    );
    setArtifacts((current) =>
      current.map((artifact) => {
        const status = statusById.get(artifact.id);
        return status
          ? { ...artifact, status, statusRaw: undefined }
          : artifact;
      })
    );
    clearSelection(setSelectedArtifactIds, selectionAnchorId);
    toast.success("Status updated", {
      action: {
        label: "Undo",
        onClick: () => setArtifacts([...previousArtifacts]),
      },
    });
  };

  return { applyBulkAction, applyBulkStatus, bulkStatusOptions };
}

/** Resolve the whole bulk selection before committing any row. */
export function resolveArtifactBulkStatusUpdates(
  artifacts: readonly GenericArtifact[],
  key: string
) {
  const resolved = artifacts.map((artifact) => ({
    artifact,
    status: genericArtifactStatusForSelection(artifact, key),
  }));
  if (resolved.some((entry) => entry.status === null)) {
    return null;
  }
  return resolved.flatMap((entry) =>
    entry.status !== entry.artifact.status ||
    entry.artifact.statusRaw !== undefined
      ? [{ artifactId: entry.artifact.id, status: entry.status! }]
      : []
  );
}

export function clearSelection(
  setSelectedArtifactIds: Dispatch<SetStateAction<Set<string>>>,
  selectionAnchorId: RefObject<string | null>
) {
  setSelectedArtifactIds(new Set());
  selectionAnchorId.current = null;
}
