import type { FriendlyErrorInput } from "@repo/api/src/types/friendly-error";
import { resolveFriendlyError } from "@repo/api/src/types/friendly-error";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { cn } from "@repo/design-system/lib/utils";
import { AlertCircleIcon } from "lucide-react";

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
    <Alert
      className={cn("border-destructive/30 bg-destructive/10", className)}
      variant="destructive"
    >
      <AlertCircleIcon className="h-4 w-4" />
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
              <summary className="cursor-pointer font-medium text-xs">
                Technical details
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background/70 p-2 text-xs">
                {technicalDetails}
              </pre>
            </details>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}
