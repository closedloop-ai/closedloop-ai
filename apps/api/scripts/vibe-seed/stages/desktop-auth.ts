import { seedVibeDesktopSession } from "../desktop-auth/desktop-session-rows";
import type { VibeSeedStage } from "../stage";

export const STAGES: readonly VibeSeedStage[] = [
  {
    name: "desktop-auth",
    models: ["DesktopSession", "DesktopRefreshToken"],
    run: async (context) => {
      if (context.desktopAuth === null) {
        context.log("desktop-auth: no Desktop auth material, skipping");
        return;
      }
      const rows = await seedVibeDesktopSession({
        prisma: context.prisma,
        userId: context.userId,
        organizationId: context.organizationId,
        material: context.desktopAuth,
        now: context.now,
      });
      context.log(
        `desktop-auth: desktop session ${rows.sessionId} for gateway ${context.desktopAuth.gatewayId}, refresh token expires ${rows.expiresAt.toISOString()}`
      );
    },
  },
];
