import { z } from "zod";

export type SessionTabCursor = { t: string | null; id: string };

const cursorSchema = z.object({ t: z.iso.datetime().nullable(), id: z.uuid() });

export function decodeSessionTabCursor(raw: string): SessionTabCursor | null {
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
