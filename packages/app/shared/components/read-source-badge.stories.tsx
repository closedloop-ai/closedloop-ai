import { ReadSource } from "@repo/api/src/types/read-source";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { ReadSourceBadge } from "./read-source-badge";

/**
 * `ReadSourceBadge` says which store a surface actually read from, and — since
 * ISS-5477 — WHY that source is in play right now.
 *
 * The second dimension is the one worth eyeballing. The `detail` sentence is
 * state-driven (draining vs. stalled vs. never-arriving), the badge's tone
 * carries whether the read can be trusted as complete, and the tooltip has an
 * ordering contract: the user-facing reason leads, the FEA-3120 QA/support
 * diagnostic sits underneath it, muted. A wrong tone or a garbled detail is
 * exactly what this gallery is here to catch — so each row prints the `detail`
 * it was handed next to the badge rather than hiding it behind a hover.
 */
const DRAINING =
  "Your history is still uploading (3,401 items to go). Nothing is missing.";
const NOT_STARTED =
  "Part of your history has not started uploading yet. Nothing is missing.";
const OFFLINE =
  "You are offline, so this is your own machine's data. Nothing is missing.";
const UNMEASURED =
  "Your history is still uploading (some items to go). Nothing is missing.";
const GAVE_UP =
  "Uploading finished except for 12 items that could not be sent. Open Diagnostics to review them.";
const FAILED_OPEN =
  "Uploading your history has not progressed for a while, so this workspace view may be missing 12 items still on this device. Open Diagnostics to review them.";

const BadgeGallery = () => (
  <div className="space-y-8">
    <Section
      description="Unchanged by ISS-5477: a caller that passes no detail renders exactly the badge that shipped before."
      title="No detail (steady state)"
    >
      <Row caption="Local — this machine's SQLite.">
        <ReadSourceBadge
          readSource={ReadSource.Local}
          surfaceLabel="sessions"
        />
      </Row>
      <Row caption="Cloud — synced workspace state, genuinely drained.">
        <ReadSourceBadge
          readSource={ReadSource.Cloud}
          surfaceLabel="sessions"
        />
      </Row>
      <Row caption="Fallback — neither read succeeded; degraded, best-effort.">
        <ReadSourceBadge
          readSource={ReadSource.Fallback}
          surfaceLabel="sessions"
        />
      </Row>
      <Row caption="Unknown source renders nothing rather than guessing.">
        <ReadSourceBadge readSource={undefined} surfaceLabel="sessions" />
      </Row>
    </Section>

    <Section
      description="The hold. Local, with a reason and a finish line — not an error and not an empty state. Every one of these reads off a complete local database, which is why each ends in 'Nothing is missing.'"
      title="Local, with a detail"
    >
      <Row caption={DRAINING}>
        <ReadSourceBadge
          detail={DRAINING}
          readSource={ReadSource.Local}
          surfaceLabel="dashboard"
        />
      </Row>
      <Row caption={NOT_STARTED}>
        <ReadSourceBadge
          detail={NOT_STARTED}
          readSource={ReadSource.Local}
          surfaceLabel="dashboard"
        />
      </Row>
      <Row caption={OFFLINE}>
        <ReadSourceBadge
          detail={OFFLINE}
          readSource={ReadSource.Local}
          surfaceLabel="branches"
        />
      </Row>
      <Row caption={UNMEASURED}>
        <ReadSourceBadge
          detail={UNMEASURED}
          readSource={ReadSource.Local}
          surfaceLabel="sessions"
        />
      </Row>
    </Section>

    <Section
      description="The states where something genuinely may not arrive. These never claim nothing is missing, and they owe the reader a next step."
      title="Stalled / blocked"
    >
      <Row caption={GAVE_UP}>
        <ReadSourceBadge
          detail={GAVE_UP}
          readSource={ReadSource.Local}
          surfaceLabel="dashboard"
        />
      </Row>
      <Row caption="Cloud that the fail-open let through. Must NOT look like the drained Cloud above — same provenance, different confidence.">
        <ReadSourceBadge
          detail={FAILED_OPEN}
          incomplete
          readSource={ReadSource.Cloud}
          surfaceLabel="dashboard"
        />
      </Row>
    </Section>
  </div>
);

function Section({
  title,
  description,
  children,
}: Readonly<{ title: string; description: string; children: ReactNode }>) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-medium text-sm uppercase tracking-wide">{title}</h3>
        <p className="max-w-2xl text-muted-foreground text-xs">{description}</p>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Row({
  caption,
  children,
}: Readonly<{ caption: string; children: ReactNode }>) {
  return (
    <div className="flex items-start gap-3 rounded-md border px-3 py-2">
      <div className="shrink-0 pt-0.5">{children}</div>
      <span className="text-muted-foreground text-xs">{caption}</span>
    </div>
  );
}

const meta = {
  title: "App Core/Shared/Read Source Badge",
  component: BadgeGallery,
  tags: ["autodocs"],
} satisfies Meta<typeof BadgeGallery>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
