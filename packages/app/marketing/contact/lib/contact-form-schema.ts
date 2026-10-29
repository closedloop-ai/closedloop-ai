import { z } from "zod";

const MESSAGE_MAX_LENGTH = 5000;
const NAME_MAX_LENGTH = 100;
const COMPANY_MAX_LENGTH = 200;
const WHOLE_NUMBER_PATTERN = /^\d+$/;

export const ContactFormField = {
  FirstName: "firstName",
  LastName: "lastName",
  Email: "email",
  Company: "company",
  EngineerCount: "engineerCount",
  Message: "message",
} as const;
export type ContactFormField =
  (typeof ContactFormField)[keyof typeof ContactFormField];

export const CONTACT_FORM_FIELD_ORDER = [
  ContactFormField.FirstName,
  ContactFormField.LastName,
  ContactFormField.Email,
  ContactFormField.Company,
  ContactFormField.EngineerCount,
  ContactFormField.Message,
] as const;

/**
 * `engineerCount` is a string on the wire because it is bound to a text input:
 * an empty field must stay distinguishable from a real `0`, which `Number("")`
 * collapses. Coercion happens here, once, at the parse boundary.
 */
export const contactFormSubmissionSchema = z.object({
  [ContactFormField.FirstName]: z.string().trim().min(1).max(NAME_MAX_LENGTH),
  [ContactFormField.LastName]: z.string().trim().min(1).max(NAME_MAX_LENGTH),
  [ContactFormField.Email]: z.string().trim().email(),
  [ContactFormField.Company]: z.string().trim().min(1).max(COMPANY_MAX_LENGTH),
  [ContactFormField.EngineerCount]: z
    .string()
    .trim()
    .min(1)
    .refine((raw) => WHOLE_NUMBER_PATTERN.test(raw), {
      message: "not a whole number",
    })
    .transform(Number)
    .refine((value) => Number.isSafeInteger(value), {
      message: "out of range",
    }),
  [ContactFormField.Message]: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH),
});

export type ContactFormSubmission = z.infer<typeof contactFormSubmissionSchema>;

export type ContactFormValues = Record<ContactFormField, string>;

export const EMPTY_CONTACT_FORM_VALUES: ContactFormValues = {
  [ContactFormField.FirstName]: "",
  [ContactFormField.LastName]: "",
  [ContactFormField.Email]: "",
  [ContactFormField.Company]: "",
  [ContactFormField.EngineerCount]: "",
  [ContactFormField.Message]: "",
};

export const ContactFormStatus = {
  Idle: "idle",
  Submitting: "submitting",
  Sent: "sent",
  Error: "error",
} as const;
export type ContactFormStatus =
  (typeof ContactFormStatus)[keyof typeof ContactFormStatus];

export const invalidContactFormFields = (
  values: ContactFormValues
): ContactFormField[] => {
  const parsed = contactFormSubmissionSchema.safeParse(values);
  if (parsed.success) {
    return [];
  }
  const flagged = new Set(
    parsed.error.issues
      .map((issue) => issue.path[0])
      .filter((key): key is ContactFormField =>
        CONTACT_FORM_FIELD_ORDER.includes(key as ContactFormField)
      )
  );
  return CONTACT_FORM_FIELD_ORDER.filter((field) => flagged.has(field));
};
