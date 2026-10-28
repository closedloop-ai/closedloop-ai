"use client";

import { ShieldCheckIcon } from "lucide-react";
import { AgentComplianceTable } from "../../../../agents/components/agent-compliance-table";
import { useAgentComponentCompliance } from "../../../../agents/hooks/use-agent-component-compliance";
import { SettingsPanelDataStateView } from "../../components/settings-panel-data-state-view";
import { SettingsPanelSection } from "../../components/settings-panel-section";
import {
  classifySettingsPanelRead,
  SettingsPanelDataState,
} from "../../lib/settings-panel-data-state";

const COMPLIANCE_SUBJECT = "compliance gaps";

/**
 * Settings v2 → Labs → **Compliance** (ISS-8367).
 *
 * Read-only: `SETTINGS_DOMAIN_ACCESS_POLICY[Compliance]` has an empty `edit`
 * for every role, so the panel offers no control at all.
 *
 * IT IS ALSO THE ONE GATED READ in the whole policy table —
 * `GET /agent-components/compliance` calls `isOrgAdmin` and answers 403 — which
 * makes the refusal an EXPECTED outcome here rather than an exotic one, and is
 * why classifying the read matters more on this panel than anywhere else. The
 * legacy tab renders a 403 and a 500 identically, through the server's raw
 * `error.message`; here they are two screens, and no server text reaches the
 * user.
 *
 * The approved preview draws this panel as a "compliance gaps" summary over
 * fixture counts. Production measures component-distribution compliance against
 * real compute targets, and the Web Master v2 scope guard is explicit that
 * fixture counts are not production requirements and an existing capability is
 * adapted rather than recreated — so the panel ships the real grid under the
 * preview's heading.
 */
export function CompliancePanel() {
  const compliance = useAgentComponentCompliance();

  const dataState = classifySettingsPanelRead({
    error: compliance.error,
    hasData: compliance.data !== undefined,
    isEmpty: (compliance.data?.items.length ?? 0) === 0,
    isPending: compliance.isPending,
  });

  return (
    <SettingsPanelSection
      description="Review required distributions and compute targets that need attention."
      title="Compliance"
    >
      {dataState === SettingsPanelDataState.Ready && compliance.data ? (
        <AgentComplianceTable
          items={compliance.data.items}
          total={compliance.data.total}
          truncated={compliance.data.truncated}
        />
      ) : (
        <SettingsPanelDataStateView
          empty={{
            description:
              "Every required distribution is installed and in use across your compute targets.",
            icon: ShieldCheckIcon,
            title: "No compliance gaps",
          }}
          onRetry={() => {
            compliance.refetch();
          }}
          state={dataState}
          subject={COMPLIANCE_SUBJECT}
        />
      )}
    </SettingsPanelSection>
  );
}
