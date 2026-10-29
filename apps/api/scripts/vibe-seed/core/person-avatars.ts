import { existsSync, readFileSync } from "node:fs";

/**
 * ISS-12135: a seeded person's profile picture, an illustrated portrait
 * committed beside this file (`avatars/<handle>.webp`, the Lorelei style by
 * Lisa Wischofsky, CC0 1.0) rather than fetched, so
 * no seeded person shows a real person's photo, nothing leaves the machine,
 * and every seed draws the same face. ISS-12406: small raster data URLs keep
 * the collaboration route's complete userInfo below Liveblocks' 2048-byte
 * limit. SVG sources, licenses and offline conversion live in `avatars/`.
 */

const AVATAR_DIRECTORY = new URL("./avatars/", import.meta.url);

/** The portrait for `handle`, or null for a handle the seed has no portrait for. */
export function vibeSeedAvatar(handle: string): string | null {
  const file = new URL(`${handle}.webp`, AVATAR_DIRECTORY);
  if (!(VIBE_SEED_AVATAR_HANDLE.test(handle) && existsSync(file))) {
    return null;
  }
  return `data:image/webp;base64,${readFileSync(file).toString("base64")}`;
}

const VIBE_SEED_AVATAR_HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
