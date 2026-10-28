import { ReadSource } from "@repo/api/src/types/read-source";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { ReadSourceBadge } from "./read-source-badge";

/**
 * `ReadSourceBadge` says which store a surface actually read from, and WHY that
 * source is in play right now.
 *
 * The second dimension is the one worth eyeballing. Since ISS-6972 the desktop
 * read source is one condition — authenticated and online, consent having left
 * it on 2026-09-25 because it governs what this Mac SENDS — so `detail` is one
 * of exactly two reasons, and the tooltip has an ordering
 * contract: the user-facing reason leads, the FEA-3120 QA/support diagnostic
 * sits underneath it, muted. A garbled detail is what this gallery is here to
 * catch, so each row prints the `detail` it was handed next to the badge rather
 * than hiding it behind a hover.
 */
const SIGNED_OUT = "You're signed out.";
const OFFLINE = "You're offline.";

const BadgeGallery = () => (
  <div className="space-y-8">
    <Section
      description="A caller that passes no detail renders the badge alone — which is every web surface, and any desktop surface reading the cloud."
      title="No detail (steady state)"
    >
      <Row caption="Local — this machine's SQLite.">
        <ReadSourceBadge
          readSource={ReadSource.Local}
          surfaceLabel="sessions"
        />
      </Row>
      <Row caption="Cloud — synced workspace state.">
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
      description="Local, with the reason the desktop predicate produced. Each is a state with a cause the reader can act on — not an error, and not an empty workspace."
      title="Local, with a detail"
    >
      <Row caption={SIGNED_OUT}>
        <ReadSourceBadge
          detail={SIGNED_OUT}
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
  title: "Composites v1.0/App Shell/Read Source Badge",
  component: BadgeGallery,
  // Every source/detail combination side by side, not one concept per story —
  // kept out of the AI manifest for that reason.
  tags: ["deprecated", "autodocs", "!manifest"],
} satisfies Meta<typeof BadgeGallery>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
