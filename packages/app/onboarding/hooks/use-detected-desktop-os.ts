"use client";

import { useEffect, useState } from "react";
import type { DetectedPlatform } from "../lib/desktop-platform-availability";
import { detectDesktopOs } from "../lib/desktop-platform-availability";

/**
 * The visitor's platform, or `null` while it is not known yet.
 *
 * `null` IS the point. The read has to happen in an effect -- both consumers are
 * server-rendered first, and a `navigator` read during render would produce
 * markup the server could not have produced -- so there is a commit before the
 * answer arrives. Seeding that commit with a default instead makes the surface
 * assert a platform nobody measured, and a warm TanStack cache renders the setup
 * checklist's row on that very first commit -- so whatever the seed decided is on
 * screen, not theoretical. Until ISS-9708 the cost there was concrete: the row
 * carried the macOS `.dmg`, so a seeded platform left the wrong artifact
 * reachable. That row is platform-neutral now; the wizard step, which resolves a
 * per-platform asset from its host, still pays it.
 *
 * Callers must render their not-yet-known shape for `null` rather than
 * coalescing it to a platform. That is the same loading/unavailable/known
 * distinction ISS-9651 exists to keep -- and `null` is NOT
 * `DetectedPlatform.Unrecognized`, which is a completed read that named no
 * desktop OS and which callers owe a different shape again.
 */
export function useDetectedDesktopOs(): DetectedPlatform | null {
  const [detectedOs, setDetectedOs] = useState<DetectedPlatform | null>(null);

  useEffect(() => {
    setDetectedOs(detectDesktopOs());
  }, []);

  return detectedOs;
}
