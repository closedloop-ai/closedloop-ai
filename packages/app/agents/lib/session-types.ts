// biome-ignore-all lint/performance/noBarrelFile: transitional re-export bridge — domain type definitions stay in @repo/design-system until PR A2 relocates them here (design-system is a leaf and cannot import from @repo/app). The re-exports become real definitions in A2 and this suppression is removed.
// Domain (agent/session) type home for the App Core surface.
//
// Migration note (PR A1 of the design-system → packages/app move):
// These Closedloop domain types currently live in
// `@repo/design-system/components/ui/types.ts` for historical (pre-monorepo
// desktop) reasons. `packages/design-system` is a leaf that MUST NOT import
// from `packages/app`, and several design-system domain components
// (session-table, agent-card, pack-card, session-detail-panels, …) still
// consume these types in place — they move out in PR A2. Until then the type
// *definitions* cannot physically leave design-system without breaking those
// components, so this module re-exports them to establish the canonical
// import path (`@repo/app/agents/lib/session-types`) that external consumers
// and A2's relocated components use. When A2 moves the last design-system
// consumer, the definitions move here and the design-system copies are deleted.
//
// SSOT: no type is duplicated — this file only re-exports.

export type {
  ActivityFeedRecord,
  ActivityItem,
  // Status / harness
  AgentStatus,
  AlwaysAllowRule,
  Approval,
  ApprovalAction,
  CcArtifact,
  CcCounts,
  CcHookScript,
  CcHookSource,
  CcKeybindingGroup,
  CcMarketplace,
  CcMcpServer,
  CcMemoryItem,
  CcPlugin,
  CcRoot,
  // Claude Code config (desktop)
  CcScope,
  CcSettingsSource,
  CcStatusline,
  CcTabKey,
  CliTool,
  CliToolState,
  DashboardHealthRecord,
  // Dashboard / health
  DashboardSeriesPoint,
  // Relay / shell
  EndpointConfig,
  EventFilterSelection,
  FeatureFlag,
  Harness,
  ImportHistoryItem,
  // Desktop app domain (jobs, approvals, security, settings)
  Job,
  KanbanView,
  LogEntry,
  MaintenanceAction,
  NotificationPreference,
  Pack,
  PackContentItem,
  PackDetail,
  PackInstall,
  PackInstallCommand,
  PackInstallRun,
  PackPostInstall,
  // Packs
  PackUsage,
  Plan,
  PlanVersion,
  PolicyOverride,
  // Pull requests
  PullRequest,
  PullRequestSession,
  RelaySettings,
  RunComposer,
  RunMode,
  RunSessionRecord,
  // Runs
  RunStatus,
  RunSummary,
  RuntimePricingDraft,
  RuntimePricingRule,
  SandboxPolicy,
  SavedConfig,
  SavedConfigStatus,
  SecurityKey,
  SecurityPosture,
  // Agents / events
  SessionAgent,
  SessionControls,
  SessionDetailRecord,
  SessionEvent,
  SessionEventFacets,
  SessionEventGroup,
  SessionOverviewStats,
  // Sessions
  SessionRow,
  SessionStatus,
  ShellConnectionEvent,
  ShellConnectionSummary,
  ShellLanguageOption,
  ShellNavItem,
  ShellRecord,
  ShellUpdateStatus,
  Skill,
  SkillInvocation,
  SubagentDispatch,
  SystemStatusItem,
  ToolEvent,
  // Tools / skills / plans
  ToolFacet,
  WorkflowCompactionImpactData,
  WorkflowComplexityItem,
  WorkflowConcurrencyData,
  WorkflowConcurrencyLane,
  WorkflowData,
  WorkflowEffectivenessItem,
  WorkflowModelDelegationData,
  WorkflowOrchestrationData,
  WorkflowOrchestrationEdge,
  WorkflowPattern,
  WorkflowPatternsData,
  WorkflowSessionDrillIn,
  // Workflows
  WorkflowStats,
  WorkflowToolFlowData,
} from "@repo/design-system/components/ui/types";
// Status / enum const values (runtime).
export {
  AGENT_STATUS,
  CLI_TOOL_STATE,
  SESSION_STATUS,
} from "@repo/design-system/components/ui/types";
