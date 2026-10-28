/** Exact project writes used by the shared project index and stack rank. */
export function buildProjectWriteRoutes(uuidSegment: string) {
  return {
    POST: [
      projectsCollectionRoute,
      new RegExp(`^/projects/${uuidSegment}/(?:favorite|artifacts/move)$`),
      new RegExp(`^/projects/${uuidSegment}/artifacts/hierarchy-transactions$`),
    ],
    PUT: [new RegExp(`^/projects/${uuidSegment}$`)],
    DELETE: [new RegExp(`^/projects/${uuidSegment}(?:/favorite)?$`)],
  } as const satisfies Record<string, readonly RegExp[]>;
}

const projectsCollectionRoute = /^\/projects$/;
