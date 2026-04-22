import { match as matchLocale } from "@formatjs/intl-localematcher";
import { log } from "@repo/observability/log";
import Negotiator from "negotiator";
import { createI18nMiddleware } from "next-international/middleware";
import languine from "./languine.json" with { type: "json" };

const locales = [languine.locale.source, ...languine.locale.targets];

const DEFAULT_LOCALE = languine.locale.source;

const I18nMiddleware = createI18nMiddleware({
  locales,
  defaultLocale: DEFAULT_LOCALE,
  urlMappingStrategy: "rewriteDefault",
  resolveLocaleFromRequest: (request) => {
    const headers = Object.fromEntries(request.headers.entries());
    const negotiator = new Negotiator({ headers });
    const acceptedLanguages = negotiator.languages();
    try {
      return matchLocale(acceptedLanguages, locales, DEFAULT_LOCALE);
    } catch (err) {
      if (err instanceof RangeError) {
        log.warn("i18n locale resolution failed, falling back to default", {
          error: err.message,
        });
        return DEFAULT_LOCALE;
      }
      throw err;
    }
  },
}) as ReturnType<typeof createI18nMiddleware>;

export const internationalizationMiddleware = I18nMiddleware;

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};

//https://nextjs.org/docs/app/building-your-application/routing/internationalization
//https://github.com/vercel/next.js/tree/canary/examples/i18n-routing
//https://github.com/QuiiBz/next-international
//https://next-international.vercel.app/docs/app-middleware-configuration
