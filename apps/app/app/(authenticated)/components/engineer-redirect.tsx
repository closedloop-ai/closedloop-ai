"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useCurrentUser } from "@/hooks/queries/use-users";
import { appEnvironment } from "@/lib/environment";

/**
 * Client component that redirects ENGINEER-role users to /engineer
 * when running on localhost. Renders nothing visible.
 */
export function EngineerRedirect() {
  const { data: currentUser } = useCurrentUser();
  const router = useRouter();

  useEffect(() => {
    if (appEnvironment === "local" && currentUser?.role === "ENGINEER") {
      router.replace("/engineer");
    }
  }, [currentUser?.role, router]);

  return null;
}
