type FailedDayProbeArgs = {
  where: {
    organizationId: string;
    lastSuccessAt: null;
    day?: { gte?: Date; lte?: Date };
  };
};

/**
 * A `penseroBackfillDay.findFirst` over ONE failed day for `organizationId`,
 * matched with Prisma's semantics: an absent key or bound constrains nothing,
 * `gte`/`lte` are inclusive.
 */
export function failedPenseroDayFindFirst(
  organizationId: string,
  failedDay: Date
) {
  return ({ where }: FailedDayProbeArgs) => {
    const matches =
      where.organizationId === organizationId &&
      where.lastSuccessAt === null &&
      !(where.day?.gte && failedDay < where.day.gte) &&
      !(where.day?.lte && failedDay > where.day.lte);
    return Promise.resolve(matches ? { id: "failed-day" } : null);
  };
}
