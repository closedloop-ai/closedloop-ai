"use client";

import { usePostHog } from "@posthog/next";
import { useUser } from "@repo/auth/client";
import { useEffect } from "react";

export function useIdentifyUser() {
  const posthog = usePostHog();
  const { user, isLoaded } = useUser();

  const email = user?.primaryEmailAddress?.emailAddress;
  const name = user?.fullName;
  const lastLogin = user?.lastSignInAt?.toISOString();
  const signupDate = user?.createdAt?.toISOString();

  useEffect(() => {
    if (!isLoaded) {
      return;
    }
    if (user?.id) {
      posthog.identify(
        user.id,
        {
          email,
          name,
          "Latest Login Date": lastLogin,
        },
        {
          "Initial Signup Date": signupDate,
        }
      );
    } else {
      posthog.reset();
    }
  }, [isLoaded, user?.id, email, name, lastLogin, signupDate, posthog]);
}
