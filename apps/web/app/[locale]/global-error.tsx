"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { fonts } from "@repo/design-system/lib/fonts";
import { log } from "@repo/observability/log";
import type NextError from "next/error";
import { useEffect } from "react";

type GlobalErrorProperties = {
  readonly error: NextError & { digest?: string };
  readonly reset: () => void;
};

const GlobalError = ({ error, reset }: GlobalErrorProperties) => {
  useEffect(() => {
    // Sanctioned client logging: a Next App Router error boundary only renders
    // when the app has already failed.
    log.error("global error boundary", { digest: error.digest });
  }, [error]);

  return (
    <html className={fonts} lang="en">
      <body>
        <h1>Oops, something went wrong</h1>
        <Button onClick={() => reset()}>Try again</Button>
      </body>
    </html>
  );
};

export default GlobalError;
