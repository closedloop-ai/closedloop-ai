"use client";

import { ArrowRight, X } from "lucide-react";
import { useEffect, useState } from "react";

const STORAGE_KEY = "site-banner:healthy:dismissed";

export const SiteBanner = () => {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setDismissed(globalThis.localStorage?.getItem(STORAGE_KEY) === "true");
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    globalThis.localStorage?.setItem(STORAGE_KEY, "true");
  };

  if (dismissed) {
    return null;
  }

  return (
    <div className="w-full bg-primary text-primary-foreground">
      <div className="mx-auto flex w-full max-w-[1300px] items-center gap-3 px-6 py-2 md:px-10">
        <p className="flex-1 text-sm">
          Looking for the healthcare data science platform?{" "}
          <a
            className="ml-1 inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
            href="https://www.gethealthy.com"
            rel="noopener noreferrer"
            target="_blank"
          >
            Visit GetHealthy.com
            <ArrowRight className="size-3.5" />
          </a>
        </p>
        <button
          aria-label="Dismiss banner"
          className="-mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-primary-foreground/80 transition-colors hover:bg-primary-foreground/10 hover:text-primary-foreground"
          onClick={handleDismiss}
          type="button"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
};
