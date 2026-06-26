"use client";

import { useAnalytics } from "@repo/analytics/client";
import { useGitHubContributors } from "@repo/app/github/hooks/use-github-integration";
import { useOrganization } from "@repo/auth/client";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Loader2, Mail, Plus, Trash2, UserPlus, Users } from "lucide-react";
import Image from "next/image";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_INVITE_ROLE = "org:member";

type InviteTeamStepProps = {
  readonly onNext: () => void;
};

type ContributorRow = {
  login: string;
  avatarUrl: string;
  email: string;
  selected: boolean;
};

type ManualRow = {
  id: string;
  email: string;
};

export function InviteTeamStep({ onNext }: InviteTeamStepProps) {
  const analytics = useAnalytics();
  const { organization } = useOrganization();
  const { data: contributorsData, isLoading: contributorsLoading } =
    useGitHubContributors();

  const [contributorRows, setContributorRows] = useState<
    ContributorRow[] | null
  >(null);
  const [manualRows, setManualRows] = useState<ManualRow[]>([
    { id: createRowId(), email: "" },
  ]);
  const [isSending, setIsSending] = useState(false);

  // Sync contributor rows from query data when it loads
  const rows = useMemo<ContributorRow[]>(() => {
    if (contributorRows !== null) {
      return contributorRows;
    }
    const fetched = contributorsData?.contributors ?? [];
    return fetched.map((c) => ({
      login: c.login,
      avatarUrl: c.avatarUrl,
      email: "",
      selected: false,
    }));
  }, [contributorRows, contributorsData]);

  const updateContributor = useCallback(
    (login: string, patch: Partial<ContributorRow>) => {
      setContributorRows((prev) => {
        const base = prev ?? rows;
        return base.map((row) =>
          row.login === login ? { ...row, ...patch } : row
        );
      });
    },
    [rows]
  );

  const addManualRow = useCallback(() => {
    setManualRows((prev) => [...prev, { id: createRowId(), email: "" }]);
  }, []);

  const updateManualRow = useCallback((id: string, email: string) => {
    setManualRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, email } : row))
    );
  }, []);

  const removeManualRow = useCallback((id: string) => {
    setManualRows((prev) => {
      if (prev.length <= 1) {
        return [{ id: createRowId(), email: "" }];
      }
      return prev.filter((row) => row.id !== id);
    });
  }, []);

  const { valid: validEmails, invalid: invalidEmails } = useMemo(
    () => collectEmails(rows, manualRows),
    [rows, manualRows]
  );

  const handleSendInvites = useCallback(async () => {
    if (!organization) {
      toast.error("Organization not loaded yet — please try again");
      return;
    }

    if (invalidEmails.length > 0) {
      analytics.capture("onboarding_invite_email_validation_failed", {
        invalid_count: invalidEmails.length,
        valid_count: validEmails.length,
      });
      toast.error(
        `Invalid email${invalidEmails.length === 1 ? "" : "s"}: ${invalidEmails.join(", ")}`
      );
      return;
    }

    if (validEmails.length === 0) {
      toast.error("Add at least one email to send invitations");
      return;
    }

    setIsSending(true);
    analytics.capture("onboarding_invite_send_attempted", {
      invitation_count: validEmails.length,
      contributor_count: rows.filter((r) => r.selected).length,
      manual_count: manualRows.filter((r) => r.email.trim().length > 0).length,
    });
    try {
      await organization.inviteMembers({
        emailAddresses: validEmails,
        role: DEFAULT_INVITE_ROLE,
      });
      analytics.capture("onboarding_invite_send_succeeded", {
        invitation_count: validEmails.length,
      });
      toast.success(
        `Sent ${validEmails.length} invitation${validEmails.length === 1 ? "" : "s"}`
      );
      onNext();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to send invitations";
      analytics.capture("onboarding_invite_send_failed", {
        invitation_count: validEmails.length,
        error_message: message,
      });
      toast.error(message);
    } finally {
      setIsSending(false);
    }
  }, [
    organization,
    validEmails,
    invalidEmails,
    rows,
    manualRows,
    analytics,
    onNext,
  ]);

  const totalReady = validEmails.length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-semibold text-lg">Invite your teammates</h2>
        <p className="text-muted-foreground text-sm">
          Invite collaborators to join your organization. We&apos;ve pulled
          contributors from your connected repositories — add their email or
          enter new addresses below.
        </p>
      </div>

      <ContributorSection
        isLoading={contributorsLoading}
        onUpdate={updateContributor}
        rows={rows}
      />

      <ManualEmailSection
        onAdd={addManualRow}
        onChange={updateManualRow}
        onRemove={removeManualRow}
        rows={manualRows}
      />

      <div className="flex items-center justify-between">
        <Button
          className="text-muted-foreground"
          disabled={isSending}
          onClick={onNext}
          size="sm"
          variant="ghost"
        >
          Skip for now
        </Button>
        <Button
          disabled={isSending || totalReady === 0}
          onClick={handleSendInvites}
        >
          {isSending && <Loader2 className="h-4 w-4 animate-spin" />}
          {totalReady > 0
            ? `Send ${totalReady} invitation${totalReady === 1 ? "" : "s"}`
            : "Send invitations"}
        </Button>
      </div>
    </div>
  );
}

type ContributorSectionProps = {
  readonly rows: ContributorRow[];
  readonly isLoading: boolean;
  readonly onUpdate: (login: string, patch: Partial<ContributorRow>) => void;
};

function ContributorSection({
  rows,
  isLoading,
  onUpdate,
}: ContributorSectionProps) {
  if (isLoading) {
    return (
      <div className="rounded-lg border p-4">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading contributors from your repositories…
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-center">
        <Users className="mx-auto h-5 w-5 text-muted-foreground" />
        <p className="mt-2 text-muted-foreground text-sm">
          No GitHub contributors found. Connect a repository or invite people
          manually below.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <Users className="h-3.5 w-3.5" />
        Suggested from your repositories
      </div>
      <div className="divide-y rounded-lg border">
        {rows.map((row) => (
          <ContributorRowItem
            key={row.login}
            onEmailChange={(email) => onUpdate(row.login, { email })}
            onSelectedChange={(selected) => onUpdate(row.login, { selected })}
            row={row}
          />
        ))}
      </div>
    </div>
  );
}

type ContributorRowItemProps = {
  readonly row: ContributorRow;
  readonly onSelectedChange: (selected: boolean) => void;
  readonly onEmailChange: (email: string) => void;
};

function ContributorRowItem({
  row,
  onSelectedChange,
  onEmailChange,
}: ContributorRowItemProps) {
  const checkboxId = `contributor-${row.login}`;
  return (
    <div className="flex items-center gap-3 p-3">
      <input
        checked={row.selected}
        className="h-4 w-4 shrink-0 rounded border-input"
        id={checkboxId}
        onChange={(e) => onSelectedChange(e.target.checked)}
        type="checkbox"
      />
      <label
        className="flex min-w-0 flex-1 items-center gap-3"
        htmlFor={checkboxId}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
          {row.avatarUrl ? (
            <Image
              alt={row.login}
              className="h-8 w-8"
              height={32}
              src={row.avatarUrl}
              unoptimized
              width={32}
            />
          ) : (
            <UserPlus className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <p className="min-w-0 flex-1 truncate font-medium text-sm">
          {row.login}
        </p>
      </label>
      <Input
        aria-label={`Invite ${row.login} by email`}
        className="h-8 max-w-[220px]"
        onChange={(e) => onEmailChange(e.target.value)}
        placeholder="email@example.com"
        type="email"
        value={row.email}
      />
    </div>
  );
}

type ManualEmailSectionProps = {
  readonly rows: ManualRow[];
  readonly onChange: (id: string, email: string) => void;
  readonly onAdd: () => void;
  readonly onRemove: (id: string) => void;
};

function ManualEmailSection({
  rows,
  onChange,
  onAdd,
  onRemove,
}: ManualEmailSectionProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <Mail className="h-3.5 w-3.5" />
        Or invite by email
      </div>
      <div className="space-y-2">
        {rows.map((row) => (
          <div className="flex items-center gap-2" key={row.id}>
            <Input
              aria-label="Email address"
              onChange={(e) => onChange(row.id, e.target.value)}
              placeholder="teammate@company.com"
              type="email"
              value={row.email}
            />
            <Button
              aria-label="Remove email row"
              onClick={() => onRemove(row.id)}
              size="icon"
              variant="ghost"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      <Button onClick={onAdd} size="sm" variant="ghost">
        <Plus className="h-4 w-4" />
        Add another
      </Button>
    </div>
  );
}

function createRowId(): string {
  return `row-${Math.random().toString(36).slice(2, 10)}`;
}

function collectEmails(
  rows: ContributorRow[],
  manualRows: ManualRow[]
): { valid: string[]; invalid: string[] } {
  const collected = new Set<string>();
  const invalid = new Set<string>();

  for (const row of rows) {
    if (!row.selected) {
      continue;
    }
    const email = row.email.trim().toLowerCase();
    if (!email) {
      continue;
    }
    if (EMAIL_REGEX.test(email)) {
      collected.add(email);
    } else {
      invalid.add(email);
    }
  }

  for (const row of manualRows) {
    const email = row.email.trim().toLowerCase();
    if (!email) {
      continue;
    }
    if (EMAIL_REGEX.test(email)) {
      collected.add(email);
    } else {
      invalid.add(email);
    }
  }

  return { valid: [...collected], invalid: [...invalid] };
}
