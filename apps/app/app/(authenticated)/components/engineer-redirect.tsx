"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useCurrentUser } from "@/hooks/queries/use-users";
import { appEnvironment } from "@/lib/environment";

// Only redirect once per app load so the Home button works as an escape hatch.
let hasRedirected = false;

/**
 * Client component that redirects ENGINEER-role users to /engineer
 * when running on localhost. Only redirects once per app load.
 */
export function EngineerRedirect() {
  const { data: currentUser } = useCurrentUser();
  const router = useRouter();

  useEffect(() => {
    if (hasRedirected) {
      return;
    }
    if (appEnvironment === "local" && currentUser?.role === "ENGINEER") {
      hasRedirected = true;
      router.replace("/engineer");
    }
  }, [currentUser?.role, router]);

  return null;
}
