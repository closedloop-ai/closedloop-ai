import { randomBytes } from "node:crypto";
import { withDb } from "@repo/database";

export const publicDashboardTokenService = {
  async getToken(organizationId: string): Promise<string | null> {
    const org = await withDb((db) =>
      db.organization.findUnique({
        where: { id: organizationId },
        select: { publicDashboardToken: true },
      })
    );
    return org?.publicDashboardToken ?? null;
  },

  async generateToken(organizationId: string): Promise<string> {
    const token = randomBytes(18).toString("base64url"); // 24 chars, 144 bits
    await withDb((db) =>
      db.organization.update({
        where: { id: organizationId },
        data: { publicDashboardToken: token },
      })
    );
    return token;
  },

  async revokeToken(organizationId: string): Promise<void> {
    await withDb((db) =>
      db.organization.update({
        where: { id: organizationId },
        data: { publicDashboardToken: null },
      })
    );
  },
};
