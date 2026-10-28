"use client";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Separator } from "@repo/design-system/components/ui/separator";
import {
  AppWindowIcon,
  DownloadIcon,
  LaptopIcon,
  PanelsTopLeftIcon,
  Trash2Icon,
} from "lucide-react";
import { SyncPolicy } from "./guided-ftue-modal";
import { PrototypeMode } from "./prototype-developer-menu";
import {
  type ConnectionState,
  SettingsSection,
  useSettingsAnnotationsVisible,
} from "./settings-surface-parts";
import { useWebMasterPrototype } from "./web-master-prototype-context";
export function ConnectedDevicesSettings() {
  return (
    <SettingsSection
      description="Manage signed-in browsers, desktop clients, and device sync preferences."
      title="Connected Devices"
    >
      <Card>
        <CardContent className="divide-y p-0">
          <ActiveSignIn current />
          <ActiveSignIn />
          <RegisteredDesktop
            current
            detail="macOS · Connected just now"
            name="Ottilie's MacBook Air"
          />
          <RegisteredDesktop
            detail="macOS · Last connected Jun 19, 2026"
            name="Studio Mac"
            showSyncPolicyAnnotation
            syncLevel={SyncPolicy.Insights}
          />
        </CardContent>
      </Card>
    </SettingsSection>
  );
}

// One label per sync policy, read by both the editable Select and the read-only
// row, so the two spellings of a policy can never drift apart.
const SYNC_LEVEL_LABELS: Record<SyncPolicy, string> = {
  [SyncPolicy.Full]: "Full sessions",
  [SyncPolicy.Insights]: "Metadata only",
  [SyncPolicy.Local]: "Keep it local",
};

function RegisteredDesktop({
  current = false,
  detail,
  name,
  showSyncPolicyAnnotation = false,
  syncLevel,
}: {
  current?: boolean;
  detail: string;
  name: string;
  showSyncPolicyAnnotation?: boolean;
  /** Only a non-current device carries its own value; this device's policy is
   *  the one the prototype owns, shared with onboarding. */
  syncLevel?: SyncPolicy;
}) {
  const annotationsVisible = useSettingsAnnotationsVisible();
  const { setSyncPolicy, syncPolicy } = useWebMasterPrototype();
  const selectedLevel = current ? syncPolicy : syncLevel;

  return (
    <div className="flex flex-wrap items-center gap-4 p-4">
      <AppWindowIcon
        aria-label="Closedloop desktop app"
        className="size-5 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-sm">{name}</p>
          <Badge variant="outline">Closedloop Desktop</Badge>
          {current ? <Badge variant="secondary">This device</Badge> : null}
        </div>
        <p className="mt-1 text-muted-foreground text-sm">{detail}</p>
      </div>
      <div className="relative flex items-center gap-2">
        {current ? (
          <Label
            className="text-muted-foreground text-xs"
            htmlFor={`sync-${name}`}
          >
            Session sync
          </Label>
        ) : (
          <span className="text-muted-foreground text-xs">Session sync</span>
        )}
        {current ? (
          // An empty value is the unset policy (ISS-12363): it shows as not
          // chosen rather than as a level nobody picked.
          <Select onValueChange={setSyncPolicy} value={syncPolicy ?? ""}>
            <SelectTrigger
              aria-label={`Session sync for ${name}`}
              className="w-40"
              id={`sync-${name}`}
            >
              <SelectValue placeholder="Not chosen" />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(SYNC_LEVEL_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          // A policy belongs to the device that holds it, and the prototype has
          // no contract for pushing one to a machine that is offline, so another
          // device's policy is reported rather than offered as a control.
          <span className="w-40 text-sm" id={`sync-${name}`}>
            {selectedLevel ? SYNC_LEVEL_LABELS[selectedLevel] : "Unknown"}
          </span>
        )}
        {showSyncPolicyAnnotation && annotationsVisible ? (
          <aside
            aria-hidden="true"
            className="pointer-events-none absolute top-[calc(100%+1.25rem)] right-0 z-20 w-96 rounded-lg bg-violet-600 px-4 py-3 text-white shadow-lg shadow-violet-950/20"
            data-prototype-annotation="desktop-sync-policy-ownership"
          >
            <span className="absolute right-12 bottom-full h-5 w-px bg-violet-500" />
            <p className="font-semibold text-[11px] text-violet-100 uppercase tracking-[0.14em]">
              Design note
            </p>
            <p className="mt-1.5 text-sm leading-5">
              Confirm with engineering whether a sync policy can be changed from
              any client and pushed to this desktop when it next comes online,
              or whether it must be edited in the desktop app itself while other
              clients display it as read-only.
            </p>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

export function LocalComputeTargetsSettings() {
  const { desktopAppDownloaded, downloadDesktopApp, mode } =
    useWebMasterPrototype();
  const isDesktop = mode === PrototypeMode.Desktop;
  let desktopConnectionLabel = "Not installed on this computer";
  let desktopConnectionState: ConnectionState = "disconnected";
  if (isDesktop) {
    desktopConnectionLabel = "Online · last seen just now";
    desktopConnectionState = "connected";
  } else if (desktopAppDownloaded) {
    desktopConnectionLabel = "Download started · connection not detected";
    desktopConnectionState = "pending";
  }

  return (
    <SettingsSection
      description="Manage desktop clients available for local analysis and agent job execution."
      title="Local Compute Targets"
    >
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <LaptopIcon className="size-5" />
                Compute targets
              </CardTitle>
              <CardDescription className="mt-1">
                Control shared execution access and run system checks.
              </CardDescription>
            </div>
            {isDesktop ? null : (
              <Button onClick={downloadDesktopApp} type="button">
                <DownloadIcon />
                {desktopAppDownloaded ? "Download again" : "Download app"}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <ComputeTarget
            connectionLabel={desktopConnectionLabel}
            name="mac.lan"
            online={desktopConnectionState === "connected"}
            systemCheckLabel={
              desktopConnectionState === "connected"
                ? "Awaiting first system check"
                : "System check unavailable"
            }
          />
          <ComputeTarget
            connectionLabel="Offline · last seen Jun 19, 2026"
            name="Andrews-MacBook-Air.local"
            online={false}
            systemCheckLabel="System check unavailable"
          />
        </CardContent>
      </Card>
    </SettingsSection>
  );
}

function ActiveSignIn({ current = false }: { current?: boolean }) {
  return (
    <div className="flex items-start gap-3 p-4">
      <PanelsTopLeftIcon
        aria-label="Browser session"
        className="mt-0.5 size-5 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-sm">Macintosh · Chrome 151</p>
          {current ? <Badge variant="secondary">This device</Badge> : null}
        </div>
        <p className="mt-1 text-muted-foreground text-sm">
          {current
            ? "Austin, United States · Active now"
            : "Austin, United States · Last active Saturday at 2:03 PM"}
        </p>
      </div>
      {current ? null : (
        <Button size="sm" variant="ghost">
          Sign out
        </Button>
      )}
    </div>
  );
}

function ComputeTarget({
  connectionLabel,
  name,
  online,
  systemCheckLabel,
}: {
  connectionLabel: string;
  name: string;
  online: boolean;
  systemCheckLabel: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex flex-wrap items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{name}</p>
            <Badge variant={online ? "default" : "secondary"}>
              {online ? "Online" : "Offline"}
            </Badge>
            <Badge variant="outline">Standard</Badge>
          </div>
          <p className="mt-1 text-muted-foreground text-sm">
            {connectionLabel}
          </p>
        </div>
        <Button size="sm" variant="outline">
          <Trash2Icon />
          Delete
        </Button>
      </div>
      <Separator />
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <p className="font-medium text-sm">Share with team</p>
          <p className="text-muted-foreground text-sm">
            Allow anyone in your organization to run jobs on this machine.
          </p>
        </div>
        <Button size="sm" variant="outline">
          Off
        </Button>
      </div>
      <Separator />
      <div className="flex flex-wrap items-center justify-between gap-3 bg-muted/20 px-4 py-3">
        <div>
          <p className="font-medium text-sm">System check</p>
          <p className="text-muted-foreground text-sm">{systemCheckLabel}</p>
        </div>
        <Button disabled={!online} size="sm" variant="outline">
          Run check
        </Button>
      </div>
    </div>
  );
}
