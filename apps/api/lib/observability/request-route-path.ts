import { z } from "zod";

/** The resolved single-segment params of the matched App Router route. */
export type RouteParams = Readonly<Record<string, string>>;

const routeContextSchema = z.object({ params: z.unknown() });
const routeParamsSchema = z.record(
  z.string(),
  z.union([z.string(), z.array(z.string())])
);

/**
 * Read the matched route's params off the route handler's second argument
 * (`{ params: Promise<Record<string, string>> }`). Anything else — no context,
 * a rejected promise, a non-string value — resolves to `undefined`, and
 * `toRouteTemplatePath` then leaves the path as it is. A catch-all value
 * (`string[]`) is dropped so the route's single-segment params still template.
 */
export async function readRouteParams(
  routeContext: unknown
): Promise<RouteParams | undefined> {
  const context = routeContextSchema.safeParse(routeContext);
  if (!context.success) {
    return;
  }
  try {
    const params = routeParamsSchema.safeParse(await context.data.params);
    if (!params.success) {
      return;
    }
    return Object.fromEntries(
      Object.entries(params.data).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
  } catch {
    return;
  }
}

/**
 * ISS-12274: the `request_completed` `path` field is the `@path` group-by of
 * the `api.requests.*` log-based metrics, so a concrete path made every record
 * id its own series. Each dynamic segment is put back to its `:name` form
 * (`/branches/<uuid>` → `/branches/:id`, the form the ticket names; Datadog
 * tags keep `:` and `/` but rewrite `[`/`]`). The concrete path stays on the
 * same line as `url.path`.
 *
 * A route handler is not given its route template, so positions come from the
 * params alone. Params with the same value are taken in route order (Next
 * builds `params` in segment order) and paired with that value's segments in
 * path order — but only when the counts are equal. More segments than params
 * means a static segment shares the value (`/branches/activity/activity` with
 * `id: "activity"`), the position is ambiguous, and those segments are left
 * as they are. That can only happen when the value equals a static segment
 * name, so it adds no per-record series.
 */
export function toRouteTemplatePath(
  pathname: string,
  routeParams: RouteParams | undefined
): string {
  if (!routeParams) {
    return pathname;
  }
  const segments = pathname.split("/");
  for (const [value, names] of groupNamesByValue(routeParams)) {
    const positions = segmentPositions(segments, value);
    if (positions.length !== names.length) {
      continue;
    }
    for (const [order, position] of positions.entries()) {
      segments[position] = `:${names[order]}`;
    }
  }
  return segments.join("/");
}

function groupNamesByValue(routeParams: RouteParams): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [name, value] of Object.entries(routeParams)) {
    if (value.length === 0) {
      continue;
    }
    const names = groups.get(value);
    if (names) {
      names.push(name);
    } else {
      groups.set(value, [name]);
    }
  }
  return groups;
}

function segmentPositions(
  segments: readonly string[],
  value: string
): number[] {
  const positions: number[] = [];
  for (const [index, segment] of segments.entries()) {
    if (decodeSegment(segment) === value) {
      positions.push(index);
    }
  }
  return positions;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
