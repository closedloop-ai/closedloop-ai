import { loader } from "fumadocs-core/source";
import { docs } from "@/.source/server";

export function getDocsSource(locale: string) {
  return loader({
    baseUrl: `/${locale}/docs`,
    source: docs.toFumadocsSource(),
  });
}
