"use client";

import type {
  ExportToLinearResult,
  LinearTeam,
} from "@repo/api/src/types/linear";
import { useCallback, useReducer } from "react";
import {
  exportToLinear,
  getLinearIntegrationStatus,
} from "@/app/actions/linear";

/**
 * State for Linear integration connection
 */
type ConnectionState = {
  isConnected: boolean | null;
  organizationName: string | null;
  teams: LinearTeam[];
  defaultTeamId: string | null;
};

/**
 * Full hook state
 */
type State = ConnectionState & {
  isLoading: boolean;
  isExporting: boolean;
  exportResult: ExportToLinearResult | null;
  error: string | null;
};

/**
 * State actions
 */
type Action =
  | { type: "CHECK_START" }
  | {
      type: "CHECK_SUCCESS";
      payload: {
        connected: boolean;
        organizationName?: string;
        teams?: LinearTeam[];
        defaultTeamId?: string;
      };
    }
  | { type: "CHECK_ERROR"; payload: string }
  | { type: "EXPORT_START" }
  | { type: "EXPORT_SUCCESS"; payload: ExportToLinearResult }
  | { type: "EXPORT_ERROR"; payload: string }
  | { type: "RESET" };

const initialState: State = {
  isConnected: null,
  organizationName: null,
  teams: [],
  defaultTeamId: null,
  isLoading: false,
  isExporting: false,
  exportResult: null,
  error: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "CHECK_START":
      return { ...state, isLoading: true, error: null };
    case "CHECK_SUCCESS":
      return {
        ...state,
        isLoading: false,
        isConnected: action.payload.connected,
        organizationName: action.payload.organizationName ?? null,
        teams: action.payload.teams ?? [],
        defaultTeamId: action.payload.defaultTeamId ?? null,
      };
    case "CHECK_ERROR":
      return { ...state, isLoading: false, error: action.payload };
    case "EXPORT_START":
      return {
        ...state,
        isExporting: true,
        error: null,
        exportResult: null,
      };
    case "EXPORT_SUCCESS":
      return { ...state, isExporting: false, exportResult: action.payload };
    case "EXPORT_ERROR":
      return { ...state, isExporting: false, error: action.payload };
    case "RESET":
      return { ...state, exportResult: null, error: null };
    default:
      return state;
  }
}

/**
 * Hook for exporting implementation plans to Linear.
 *
 * @param artifactId - The ID of the implementation plan artifact to export
 *
 * @example
 * ```tsx
 * const {
 *   isConnected,
 *   teams,
 *   isExporting,
 *   exportResult,
 *   error,
 *   checkConnection,
 *   exportPlan,
 * } = useLinearExport(artifactId);
 *
 * useEffect(() => {
 *   checkConnection();
 * }, [checkConnection]);
 *
 * // Render team selector if connected
 * // Call exportPlan(teamId) when user clicks export
 * ```
 */
export function useLinearExport(artifactId: string) {
  const [state, dispatch] = useReducer(reducer, initialState);

  /**
   * Check the Linear integration status for the current organization.
   */
  const checkConnection = useCallback(async () => {
    dispatch({ type: "CHECK_START" });

    try {
      const result = await getLinearIntegrationStatus();

      if (result.success) {
        dispatch({
          type: "CHECK_SUCCESS",
          payload: {
            connected: result.data.connected,
            organizationName: result.data.organizationName,
            teams: result.data.teams,
            defaultTeamId: result.data.defaultTeamId,
          },
        });
      } else {
        dispatch({ type: "CHECK_ERROR", payload: result.error });
      }
    } catch (err) {
      dispatch({
        type: "CHECK_ERROR",
        payload:
          err instanceof Error ? err.message : "Failed to check connection",
      });
    }
  }, []);

  /**
   * Export the implementation plan to Linear.
   *
   * @param teamId - The Linear team ID to create issues in
   */
  const exportPlan = useCallback(
    async (teamId: string) => {
      dispatch({ type: "EXPORT_START" });

      try {
        const result = await exportToLinear({ artifactId, teamId });

        if (result.success) {
          dispatch({ type: "EXPORT_SUCCESS", payload: result.data });
        } else {
          dispatch({ type: "EXPORT_ERROR", payload: result.error });
        }
      } catch (err) {
        dispatch({
          type: "EXPORT_ERROR",
          payload:
            err instanceof Error ? err.message : "Failed to export to Linear",
        });
      }
    },
    [artifactId]
  );

  /**
   * Reset the export result and error state.
   */
  const reset = useCallback(() => {
    dispatch({ type: "RESET" });
  }, []);

  return {
    // Connection status
    isConnected: state.isConnected,
    organizationName: state.organizationName,
    teams: state.teams,
    defaultTeamId: state.defaultTeamId,

    // Loading states
    isLoading: state.isLoading,
    isExporting: state.isExporting,

    // Results
    exportResult: state.exportResult,
    error: state.error,

    // Actions
    checkConnection,
    exportPlan,
    reset,
  };
}
