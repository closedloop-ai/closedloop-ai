import { z } from "zod";

/**
 * ISS-12135: the organizations whose invite spotlight a seeded profile already
 * answered (`DesktopSettings.inviteSpotlightAnsweredOrganizationIds`), read
 * through the settings the renderer already reads. A host with no settings
 * read, a failed read, or a malformed value answers none, which is today's
 * behavior: the nudge's own `localStorage` answer decides.
 */
export async function readSettingsInviteSpotlightAnswers(): Promise<
  readonly string[]
> {
  const read = window.desktopApi?.getSettings;
  if (typeof read !== "function") {
    return [];
  }
  try {
    const parsed = answeredSettingsSchema.safeParse(await read());
    return parsed.success
      ? (parsed.data.inviteSpotlightAnsweredOrganizationIds ?? [])
      : [];
  } catch {
    return [];
  }
}

const answeredSettingsSchema = z.object({
  inviteSpotlightAnsweredOrganizationIds: z.array(z.string()).optional(),
});
