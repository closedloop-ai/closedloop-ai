import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { AlertCircle, CheckCircle2, Loader2, ThumbsDown } from "lucide-react";
import type { ReviewVerdict } from "@/lib/engineer/codex-review-parser";

type VerdictBannerProps = {
  verdict: ReviewVerdict;
  onDecline?: () => void;
  isDeclined?: boolean;
  isSubmitting?: boolean;
};

export function VerdictBanner({
  verdict,
  onDecline,
  isDeclined,
  isSubmitting,
}: Readonly<VerdictBannerProps>) {
  if (verdict.verdict === "needs_attention") {
    return null;
  }

  if (verdict.verdict === "approve") {
    return (
      <Alert className="border-emerald-500/30 bg-emerald-500/10">
        <CheckCircle2 className="size-4 text-emerald-500" />
        <AlertTitle>Approved</AlertTitle>
        <AlertDescription>{verdict.reason}</AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert className="border-red-500/30 bg-red-500/10">
      <AlertCircle className="size-4 text-red-500" />
      <AlertTitle>Recommend Decline</AlertTitle>
      <AlertDescription>
        <p>{verdict.reason}</p>
        <DeclineAction
          isDeclined={isDeclined}
          isSubmitting={isSubmitting}
          onDecline={onDecline}
        />
      </AlertDescription>
    </Alert>
  );
}

function DeclineAction({
  onDecline,
  isDeclined,
  isSubmitting,
}: Readonly<{
  onDecline?: () => void;
  isDeclined?: boolean;
  isSubmitting?: boolean;
}>) {
  if (isDeclined) {
    return (
      <span className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-red-500/10 px-2.5 py-1 font-medium text-red-600 text-xs dark:text-red-400">
        <ThumbsDown className="size-3.5" />
        Declined
      </span>
    );
  }

  if (isSubmitting) {
    return (
      <Button className="mt-2" disabled size="sm" variant="destructive">
        <Loader2 className="mr-1.5 size-3.5 animate-spin" />
        Declining...
      </Button>
    );
  }

  return (
    <Button
      className="mt-2"
      onClick={onDecline}
      size="sm"
      variant="destructive"
    >
      <ThumbsDown className="mr-1.5 size-3.5" />
      Decline
    </Button>
  );
}
