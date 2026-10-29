"use client";

import AppError from "../error";

type AuthenticatedErrorProperties = {
  readonly error: unknown;
  readonly reset: () => void;
};

export default function AuthenticatedErrorBoundary(
  properties: AuthenticatedErrorProperties
) {
  return <AppError {...properties} />;
}
