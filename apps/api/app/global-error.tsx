"use client";

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
    <html lang="en">
      <body>
        <h1>Oops, something went wrong</h1>
        <button onClick={() => reset()} type="button">
          Try again
        </button>
      </body>
    </html>
  );
};

export default GlobalError;
