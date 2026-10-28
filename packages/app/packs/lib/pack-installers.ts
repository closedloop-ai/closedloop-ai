/**
 * ISS-6768: the single mapping from a cloud installer roster (display names) to
 * the `PackUser` rows the Packs "Used by" stack renders.
 *
 * Both pack adapters take the roster from one cloud producer
 * (`installerRosterOf` → `PackAnalyticsResponse.owners` for desktop,
 * `AgentComponentDetail.installers` for web), so they map it one way too rather
 * than each hand-rolling the initials/id derivation.
 */

import { getInitials } from "../../shared/lib/user-utils";
import type { PackUser } from "./pack-view";

/**
 * Map installer display names onto `PackUser` rows, preserving the producer's
 * order (most recently seen install first).
 *
 * The cloud roster carries names, not user ids, so the `id` is derived from the
 * name — the roster is never used to address a user, and the producer already
 * deduped on the stable user id. Names are NOT re-deduped here: two org members
 * who share a display name are two installers, and collapsing them would
 * undercount adoption. But `id` is the React key at both render sites
 * (`UserPill` rows, `InstallerStack` avatars), so a repeated name needs a
 * distinct id or the rows collide on one key and React mis-reconciles them.
 *
 * A bare `${name}#${occurrence}` suffix is not enough, because a display name
 * may itself end in one: `["Alex", "Alex", "Alex#2"]` would map the second and
 * third rows to the same `Alex#2`. So every `#` in the name is doubled first,
 * which makes the suffix unambiguous — an escaped name can never contain an odd
 * run of `#`, so `name#n` cannot be read as anything but the n-th occurrence of
 * `name`.
 */
export function packInstallersFromNames(names: readonly string[]): PackUser[] {
  const occurrences = new Map<string, number>();
  return names.map((name) => {
    const occurrence = (occurrences.get(name) ?? 0) + 1;
    occurrences.set(name, occurrence);
    const escaped = name.replaceAll("#", "##");
    return {
      id: occurrence === 1 ? escaped : `${escaped}#${occurrence}`,
      name,
      initials: getInitials(name),
    };
  });
}
