import { Button } from "@repo/design-system/components/ui/button";
import { Separator } from "@repo/design-system/components/ui/separator";
import { deviceConsent } from "../mock";

const DetailRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-4">
    <dt className="text-muted-foreground text-sm">{label}</dt>
    <dd className="text-right text-sm">{value}</dd>
  </div>
);

/**
 * The one stop in this flow that asks the user for something, so it is the one
 * that does not spin.
 *
 * WHICH LAYOUT THIS LIVES IN, because the prototype has to pick one and this is
 * the pick: the consent route stays where it is, under `(authenticated)` inside
 * the sidebar shell. Moving a settings route out of the app chrome is a real IA
 * change with no ticket behind it, and the user reaching this stop IS signed in
 * by now - the shell is honest about that. So "same family as the waiting
 * panels" means matching the heading scale, the column width, and the
 * full-width primary; it does NOT mean the full-bleed unauthenticated page this
 * prototype draws it on. Read the panel here, not the chrome around it.
 *
 * Today it ships as a left-aligned Card at max-w-xl with a size-4 inline
 * spinner, which is why it reads as a different product from the two screens
 * immediately before it. The device facts are plain rows rather than a bordered
 * box - a few labelled values do not need a container to be legible, and the
 * border was doing a layout's job.
 */
export const DeviceConsentPanel = () => (
  <div className="flex flex-col gap-6">
    <div className="flex flex-col gap-1.5 text-center">
      <h1 className="font-semibold text-2xl tracking-tight">
        Connect this device?
      </h1>
      <p className="text-muted-foreground text-sm">
        Closedloop Desktop will sign in to your workspace on this machine.
      </p>
    </div>

    <div className="flex flex-col gap-3">
      <Separator />
      {/* "Grants" leads, because it is the only row that says what is being
          approved. Device, platform, and workspace are the facts that let a
          user recognize the request; the grant is the request. The application
          name is gone - it is a constant, and the sentence above already
          said it. */}
      <dl className="flex flex-col gap-2">
        <DetailRow label="Grants" value={deviceConsent.grant} />
        <DetailRow label="Device" value={deviceConsent.device} />
        <DetailRow label="Platform" value={deviceConsent.platform} />
        <DetailRow label="Workspace" value={deviceConsent.workspace} />
      </dl>
      <Separator />
    </div>

    <div className="flex flex-col gap-2">
      <Button className="w-full" size="lg">
        Connect
      </Button>
      <Button className="w-full" size="lg" variant="ghost">
        Cancel
      </Button>
    </div>
  </div>
);
