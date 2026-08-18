import type { FriendlyErrorInput } from "@repo/api/src/types/friendly-error";
import { resolveFriendlyError } from "@repo/api/src/types/friendly-error";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { AlertCircleIcon, ChevronRightIcon } from "lucide-react";

type FriendlyErrorAlertProps = {
  error: FriendlyErrorInput;
  className?: string;
};

/**
 * Display-safe error presentation for loop and gateway failures.
 * Raw messages stay inside the explicit technical details disclosure.
 */
export function FriendlyErrorAlert({
  className,
  error,
}: Readonly<FriendlyErrorAlertProps>) {
  const friendly = resolveFriendlyError(error);
  const technicalDetails = JSON.stringify(friendly.technicalDetails, null, 2);
  const hasTechnicalDetails = technicalDetails !== "{}";

  return (
    <Alert className={className} variant="error">
      <AlertCircleIcon />
      <AlertTitle>{friendly.title}</AlertTitle>
      <AlertDescription>
        <div className="space-y-3">
          <p>{friendly.description}</p>
          {friendly.remediation.length > 0 && (
            <ul className="list-disc space-y-1 pl-4">
              {friendly.remediation.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          )}
          {hasTechnicalDetails && (
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1 font-medium text-xs [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
                Technical details
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
                {technicalDetails}
              </pre>
            </details>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}
