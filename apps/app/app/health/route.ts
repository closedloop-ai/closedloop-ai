// ISS-11832: the ECS target group and container health checks need an
// unauthenticated 200. `proxy.ts` excludes exactly this path from its matcher,
// so neither Clerk nor a redirect sits between the probe and this handler.
export function GET(): Response {
  return new Response(null, { status: 200 });
}
