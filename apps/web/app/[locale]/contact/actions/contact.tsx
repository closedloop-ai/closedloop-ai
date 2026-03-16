"use server";

import { resend } from "@repo/email";
import { ContactTemplate } from "@repo/email/templates/contact";
import { parseError } from "@repo/observability/error";
import { rateLimit } from "@repo/security";
import { headers } from "next/headers";
import { env } from "@/env";

function getClientIp(
  forwardedFor: string | null,
  realIp: string | null
): string | null {
  const trustedRealIp = realIp?.trim();
  if (trustedRealIp) {
    return trustedRealIp;
  }

  const forwardedIps = forwardedFor
    ?.split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);

  return forwardedIps?.[forwardedIps.length - 1] ?? null;
}

export const contact = async (
  name: string,
  email: string,
  message: string
): Promise<{
  error?: string;
}> => {
  try {
    const requestHeaders = await headers();
    const clientIp = getClientIp(
      requestHeaders.get("x-forwarded-for"),
      requestHeaders.get("x-real-ip")
    );

    if (clientIp) {
      try {
        await rateLimit(`contact_form_${clientIp}`, 1, "1d");
      } catch (error) {
        if (error instanceof Error && error.message === "Rate limit exceeded") {
          throw new Error(
            "You have reached your request limit. Please try again later."
          );
        }

        throw error;
      }
    }

    if (!env.RESEND_FROM) {
      throw new Error("RESEND_FROM is not configured");
    }

    await resend.emails.send({
      from: env.RESEND_FROM,
      to: env.RESEND_FROM,
      subject: "Contact form submission",
      replyTo: email,
      react: <ContactTemplate email={email} message={message} name={name} />,
    });

    return {};
  } catch (error) {
    const errorMessage = parseError(error);

    return { error: errorMessage };
  }
};
