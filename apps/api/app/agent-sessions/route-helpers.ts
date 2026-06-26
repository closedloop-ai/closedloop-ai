import { isAgentMonitoringEnabledForUser } from "@/lib/agent-session-sync-feature";

export async function getAgentSessionViewerScope(input: {
  userId: string;
  clerkUserId: string;
}): Promise<{
  monitoringEnabled: boolean;
}> {
  const monitoringEnabled = await isAgentMonitoringEnabledForUser({
    userId: input.userId,
    clerkUserId: input.clerkUserId,
  });

  return {
    monitoringEnabled,
  };
}
