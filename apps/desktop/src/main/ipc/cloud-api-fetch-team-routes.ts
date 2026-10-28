// Team writes exposed by the shared team dialog. IDs occupy exactly one UUID
// segment; the API retains organization scope and existing role authorization.
export function buildTeamWriteRoutes(uuidSegment: string) {
  return {
    POST: [
      teamsCollectionPath,
      new RegExp(`^/teams/${uuidSegment}/(?:members|repositories)$`),
    ],
    PUT: [
      new RegExp(`^/teams/${uuidSegment}$`),
      new RegExp(
        `^/teams/${uuidSegment}/(?:members|repositories)/${uuidSegment}$`
      ),
    ],
    DELETE: [
      new RegExp(`^/teams/${uuidSegment}$`),
      new RegExp(
        `^/teams/${uuidSegment}/(?:members|repositories)/${uuidSegment}$`
      ),
    ],
  } as const;
}

const teamsCollectionPath = /^\/teams$/;
