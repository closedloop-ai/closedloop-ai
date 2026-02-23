import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { AlertCircle, RefreshCw } from "lucide-react";

type ErrorFallbackProps = {
  error: Error;
  onRetry?: () => void;
};

/**
 * Reusable error fallback UI component.
 * Displays error message with retry functionality.
 */
export function ErrorFallback({
  error,
  onRetry,
}: Readonly<ErrorFallbackProps>) {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <div className="flex items-center gap-2">
          <AlertCircle className="size-5 text-destructive" />
          <CardTitle>Something went wrong</CardTitle>
        </div>
        <CardDescription>An unexpected error occurred</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-md bg-muted p-3">
          <p className="break-words font-mono text-muted-foreground text-sm">
            {error.message}
          </p>
        </div>
      </CardContent>
      {onRetry && (
        <CardFooter>
          <Button className="w-full" onClick={onRetry} variant="default">
            <RefreshCw className="mr-2 size-4" />
            Try Again
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
