"use client";

import type { SessionUntrackedRepositoryTarget } from "@repo/api/src/types/session-untracked-repository";
import { SESSION_OTHER_REPOSITORIES_PROPERTY_LABEL } from "./session-property-labels";
import { SessionOtherRepositoriesValue } from "./values/session-other-repositories-value";

/**
 * PLN-2061 M5: the session-detail Properties-pane row naming the repositories
 * the org does not track that this session's run touched. Operator ruling
 * 2026-09-18 (Kerensa Whitlock): a session shows the untracked repository it touched,
 * on session detail.
 *
 * Renders nothing when there is nothing to show, like the Linked artifacts row.
 * The pills are {@link SessionOtherRepositoriesValue}'s; this row is the label
 * and the chrome around them.
 */
export function SessionOtherRepositoriesRow({
  targets,
}: Readonly<{
  targets: readonly SessionUntrackedRepositoryTarget[];
}>) {
  if (targets.length === 0) {
    return null;
  }
  return (
    <div className="prd-prop sd3-linked-prop">
      <span className="prd-prop-label">
        {SESSION_OTHER_REPOSITORIES_PROPERTY_LABEL}
      </span>
      <div
        className="prd-prop-value sd3-prs-value"
        style={{ cursor: "default" }}
      >
        <SessionOtherRepositoriesValue targets={targets} />
      </div>
    </div>
  );
}
