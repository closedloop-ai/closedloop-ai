import { createAPIPage } from "fumadocs-openapi/ui";
import { openapi } from "@/lib/openapi";

/**
 * Server component that renders a single OpenAPI operation (or set of
 * operations) for the `/docs/api-reference` section.
 *
 * The generated MDX pages emit `<APIPage ... />` with no import of their own;
 * `APIPage` is supplied through the MDX components map in
 * `app/[locale]/docs/[[...slug]]/page.tsx`, mirroring how `CardGroup` is wired.
 */
export const APIPage = createAPIPage(openapi);
