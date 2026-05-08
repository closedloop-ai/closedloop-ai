"use client";

import { useIdentifyUser } from "../hooks/use-identify-user";

export function UserIdentifier() {
  useIdentifyUser();

  return null;
}
