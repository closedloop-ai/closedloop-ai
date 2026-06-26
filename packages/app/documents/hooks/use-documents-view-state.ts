"use client";

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import type {
  MovableEntity,
  MoveResolution,
} from "@repo/app/documents/lib/table-row-actions";
import { useMemo, useReducer } from "react";

/**
 * Interaction state for the documents table view (FEA-1763 / PLN-874
 * Phase 3): row selection, the anchored context menu, and the delete / move /
 * merge dialogs. Extracted from `documents-view.tsx`'s ten useState calls
 * into one reducer so the orchestrator component is composition-only and
 * every state transition is a named action.
 */

export type MenuState = {
  item: DocumentRowItem;
  anchor: HTMLElement;
} | null;

export type DocumentsViewState = {
  selectedIds: Set<string>;
  menuState: MenuState;
  deleteTarget: DocumentRowItem | null;
  pendingBulkIds: Set<string>;
  deleteDialogOpen: boolean;
  deletePending: boolean;
  moveEntity: MovableEntity | null;
  moveEntities: MovableEntity[];
  mergeDialogOpen: boolean;
  mergeError: string | null;
};

const INITIAL_STATE: DocumentsViewState = {
  selectedIds: new Set(),
  menuState: null,
  deleteTarget: null,
  pendingBulkIds: new Set(),
  deleteDialogOpen: false,
  deletePending: false,
  moveEntity: null,
  moveEntities: [],
  mergeDialogOpen: false,
  mergeError: null,
};

type DocumentsViewAction =
  | { type: "selectionChanged"; id: string; checked: boolean }
  | { type: "selectionReplaced"; ids: Set<string> }
  | { type: "selectionCleared" }
  | { type: "selectionPruned"; currentIds: Set<string> }
  | { type: "menuOpened"; item: DocumentRowItem; anchor: HTMLElement }
  | { type: "menuClosed" }
  | { type: "deleteRequested"; item: DocumentRowItem }
  | { type: "bulkDeleteRequested" }
  | { type: "deleteDialogOpenChanged"; open: boolean }
  | { type: "deletePendingChanged"; pending: boolean }
  | { type: "deleteSucceeded"; deletedId: string }
  | { type: "bulkDeleteSucceeded" }
  | { type: "moveRequested"; resolution: MoveResolution }
  | { type: "bulkMoveRequested"; entities: MovableEntity[] }
  | { type: "moveDialogClosed" }
  | { type: "bulkMoveDialogClosed" }
  | { type: "bulkMoveSucceeded" }
  | { type: "mergeDialogOpened" }
  | { type: "mergeDialogOpenChanged"; open: boolean }
  | { type: "mergeErrorCleared" }
  | { type: "mergeFailed"; message: string }
  | { type: "mergeSucceeded" };

function applySelectionAction(
  state: DocumentsViewState,
  action: Extract<
    DocumentsViewAction,
    {
      type:
        | "selectionChanged"
        | "selectionReplaced"
        | "selectionCleared"
        | "selectionPruned";
    }
  >
): DocumentsViewState {
  switch (action.type) {
    case "selectionChanged": {
      const next = new Set(state.selectedIds);
      if (action.checked) {
        next.add(action.id);
      } else {
        next.delete(action.id);
      }
      return { ...state, selectedIds: next };
    }
    case "selectionReplaced":
      return { ...state, selectedIds: action.ids };
    case "selectionCleared":
      if (state.selectedIds.size === 0) {
        return state;
      }
      return { ...state, selectedIds: new Set() };
    case "selectionPruned": {
      if (state.selectedIds.size === 0) {
        return state;
      }
      const pruned = new Set(
        [...state.selectedIds].filter((id) => action.currentIds.has(id))
      );
      if (pruned.size === state.selectedIds.size) {
        return state;
      }
      return { ...state, selectedIds: pruned };
    }
    default: {
      const unhandled: never = action;
      return unhandled;
    }
  }
}

function applyDeleteAction(
  state: DocumentsViewState,
  action: Extract<
    DocumentsViewAction,
    {
      type:
        | "deleteRequested"
        | "bulkDeleteRequested"
        | "deleteDialogOpenChanged"
        | "deletePendingChanged"
        | "deleteSucceeded"
        | "bulkDeleteSucceeded";
    }
  >
): DocumentsViewState {
  switch (action.type) {
    // Single and bulk delete are mutually exclusive modes sharing one dialog;
    // the confirm handler dispatches on `pendingBulkIds.size`. Each entry point
    // clears the other mode's marker, and closing the dialog clears both, so a
    // cancelled bulk delete can never bleed into a later single-row delete.
    case "deleteRequested":
      return {
        ...state,
        deleteTarget: action.item,
        pendingBulkIds: new Set(),
        deleteDialogOpen: true,
        menuState: null,
      };
    case "bulkDeleteRequested":
      return {
        ...state,
        pendingBulkIds: new Set(state.selectedIds),
        deleteTarget: null,
        deleteDialogOpen: true,
      };
    case "deleteDialogOpenChanged":
      if (action.open) {
        return { ...state, deleteDialogOpen: true };
      }
      return {
        ...state,
        deleteDialogOpen: false,
        deleteTarget: null,
        pendingBulkIds: new Set(),
      };
    case "deletePendingChanged":
      return { ...state, deletePending: action.pending };
    case "deleteSucceeded": {
      const selectedIds = new Set(state.selectedIds);
      selectedIds.delete(action.deletedId);
      return {
        ...state,
        deleteDialogOpen: false,
        deleteTarget: null,
        selectedIds,
      };
    }
    case "bulkDeleteSucceeded":
      return {
        ...state,
        deleteDialogOpen: false,
        pendingBulkIds: new Set(),
        selectedIds: new Set(),
      };
    default: {
      const unhandled: never = action;
      return unhandled;
    }
  }
}

function applyMoveMergeAction(
  state: DocumentsViewState,
  action: Extract<
    DocumentsViewAction,
    {
      type:
        | "moveRequested"
        | "bulkMoveRequested"
        | "moveDialogClosed"
        | "bulkMoveDialogClosed"
        | "bulkMoveSucceeded"
        | "mergeDialogOpened"
        | "mergeDialogOpenChanged"
        | "mergeErrorCleared"
        | "mergeFailed"
        | "mergeSucceeded";
    }
  >
): DocumentsViewState {
  switch (action.type) {
    case "moveRequested": {
      const next = { ...state, menuState: null };
      if (action.resolution.kind === "bulk") {
        next.moveEntities = action.resolution.entities;
      } else if (action.resolution.kind === "single") {
        next.moveEntity = action.resolution.entity;
      }
      return next;
    }
    case "bulkMoveRequested":
      if (action.entities.length === 0) {
        return state;
      }
      return { ...state, moveEntities: action.entities };
    case "moveDialogClosed":
      return { ...state, moveEntity: null };
    case "bulkMoveDialogClosed":
      return { ...state, moveEntities: [] };
    case "bulkMoveSucceeded":
      return { ...state, moveEntities: [], selectedIds: new Set() };
    case "mergeDialogOpened":
      return { ...state, mergeDialogOpen: true, mergeError: null };
    case "mergeDialogOpenChanged":
      return { ...state, mergeDialogOpen: action.open };
    case "mergeErrorCleared":
      if (state.mergeError === null) {
        return state;
      }
      return { ...state, mergeError: null };
    case "mergeFailed":
      return { ...state, mergeError: action.message };
    case "mergeSucceeded":
      return { ...state, mergeDialogOpen: false, selectedIds: new Set() };
    default: {
      const unhandled: never = action;
      return unhandled;
    }
  }
}

function documentsViewReducer(
  state: DocumentsViewState,
  action: DocumentsViewAction
): DocumentsViewState {
  switch (action.type) {
    case "selectionChanged":
    case "selectionReplaced":
    case "selectionCleared":
    case "selectionPruned":
      return applySelectionAction(state, action);
    case "menuOpened":
      return {
        ...state,
        menuState: { item: action.item, anchor: action.anchor },
      };
    case "menuClosed":
      if (state.menuState === null) {
        return state;
      }
      return { ...state, menuState: null };
    case "deleteRequested":
    case "bulkDeleteRequested":
    case "deleteDialogOpenChanged":
    case "deletePendingChanged":
    case "deleteSucceeded":
    case "bulkDeleteSucceeded":
      return applyDeleteAction(state, action);
    default:
      return applyMoveMergeAction(state, action);
  }
}

export function useDocumentsViewState() {
  const [state, dispatch] = useReducer(documentsViewReducer, INITIAL_STATE);

  const actions = useMemo(
    () => ({
      changeSelection: (id: string, checked: boolean) =>
        dispatch({ type: "selectionChanged", id, checked }),
      replaceSelection: (ids: Set<string>) =>
        dispatch({ type: "selectionReplaced", ids }),
      clearSelection: () => dispatch({ type: "selectionCleared" }),
      pruneSelection: (currentIds: Set<string>) =>
        dispatch({ type: "selectionPruned", currentIds }),
      openMenu: (item: DocumentRowItem, anchor: HTMLElement) =>
        dispatch({ type: "menuOpened", item, anchor }),
      closeMenu: () => dispatch({ type: "menuClosed" }),
      requestDelete: (item: DocumentRowItem) =>
        dispatch({ type: "deleteRequested", item }),
      requestBulkDelete: () => dispatch({ type: "bulkDeleteRequested" }),
      setDeleteDialogOpen: (open: boolean) =>
        dispatch({ type: "deleteDialogOpenChanged", open }),
      setDeletePending: (pending: boolean) =>
        dispatch({ type: "deletePendingChanged", pending }),
      markDeleteSucceeded: (deletedId: string) =>
        dispatch({ type: "deleteSucceeded", deletedId }),
      markBulkDeleteSucceeded: () => dispatch({ type: "bulkDeleteSucceeded" }),
      requestMove: (resolution: MoveResolution) =>
        dispatch({ type: "moveRequested", resolution }),
      requestBulkMove: (entities: MovableEntity[]) =>
        dispatch({ type: "bulkMoveRequested", entities }),
      closeMoveDialog: () => dispatch({ type: "moveDialogClosed" }),
      closeBulkMoveDialog: () => dispatch({ type: "bulkMoveDialogClosed" }),
      markBulkMoveSucceeded: () => dispatch({ type: "bulkMoveSucceeded" }),
      openMergeDialog: () => dispatch({ type: "mergeDialogOpened" }),
      setMergeDialogOpen: (open: boolean) =>
        dispatch({ type: "mergeDialogOpenChanged", open }),
      clearMergeError: () => dispatch({ type: "mergeErrorCleared" }),
      markMergeFailed: (message: string) =>
        dispatch({ type: "mergeFailed", message }),
      markMergeSucceeded: () => dispatch({ type: "mergeSucceeded" }),
    }),
    []
  );

  return { state, actions };
}
