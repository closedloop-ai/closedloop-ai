"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { type FormEvent, useId, useState } from "react";
import {
  ContactFormField,
  ContactFormStatus,
  type ContactFormSubmission,
  type ContactFormValues,
  contactFormSubmissionSchema,
  EMPTY_CONTACT_FORM_VALUES,
  invalidContactFormFields,
} from "../lib/contact-form-schema";

/**
 * Field labels are the operator's own words (Marisol Ashgrove, 2026-09-30:
 * "first / last / email / company / # of engineers / message"). Every OTHER
 * user-visible string — heading, submit label, success and failure sentences —
 * is a required prop rather than a default, so this component originates none
 * of them and a host cannot mount it without supplying copy a human ruled on
 * (root `AGENTS.md` → Human Provenance for Product Behavior).
 */
export type ContactFormCopy = {
  submitLabel: string;
  submittingLabel: string;
  sentTitle: string;
  sentBody: string;
  errorTitle: string;
  errorBody: string;
  invalidTitle: string;
  invalidBody: string;
};

export type ContactFormProps = {
  copy: ContactFormCopy;
  onSubmit: (submission: ContactFormSubmission) => Promise<void> | void;
};

const FIELD_LABEL: Record<ContactFormField, string> = {
  [ContactFormField.FirstName]: "First name",
  [ContactFormField.LastName]: "Last name",
  [ContactFormField.Email]: "Email",
  [ContactFormField.Company]: "Company",
  [ContactFormField.EngineerCount]: "Number of engineers",
  [ContactFormField.Message]: "Message",
};

const TEXT_FIELDS = [
  {
    field: ContactFormField.FirstName,
    type: "text",
    autoComplete: "given-name",
  },
  {
    field: ContactFormField.LastName,
    type: "text",
    autoComplete: "family-name",
  },
  { field: ContactFormField.Email, type: "email", autoComplete: "email" },
  {
    field: ContactFormField.Company,
    type: "text",
    autoComplete: "organization",
  },
  {
    field: ContactFormField.EngineerCount,
    type: "text",
    autoComplete: "off",
  },
] as const;

export const ContactForm = ({ copy, onSubmit }: ContactFormProps) => {
  const fieldIdPrefix = useId();
  const [values, setValues] = useState<ContactFormValues>(
    EMPTY_CONTACT_FORM_VALUES
  );
  const [status, setStatus] = useState<ContactFormStatus>(
    ContactFormStatus.Idle
  );
  const [invalidFields, setInvalidFields] = useState<ContactFormField[]>([]);

  const fieldId = (field: ContactFormField) => `${fieldIdPrefix}-${field}`;
  const isSubmitting = status === ContactFormStatus.Submitting;

  const setField = (field: ContactFormField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }
    const parsed = contactFormSubmissionSchema.safeParse(values);
    if (!parsed.success) {
      setInvalidFields(invalidContactFormFields(values));
      setStatus(ContactFormStatus.Idle);
      return;
    }
    setInvalidFields([]);
    setStatus(ContactFormStatus.Submitting);
    try {
      await onSubmit(parsed.data);
      setValues(EMPTY_CONTACT_FORM_VALUES);
      setStatus(ContactFormStatus.Sent);
    } catch {
      setStatus(ContactFormStatus.Error);
    }
  };

  if (status === ContactFormStatus.Sent) {
    return (
      <Alert>
        <AlertTitle>{copy.sentTitle}</AlertTitle>
        <AlertDescription>{copy.sentBody}</AlertDescription>
      </Alert>
    );
  }

  return (
    <form className="flex flex-col gap-6" noValidate onSubmit={handleSubmit}>
      {invalidFields.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>{copy.invalidTitle}</AlertTitle>
          <AlertDescription>{copy.invalidBody}</AlertDescription>
        </Alert>
      ) : null}
      {status === ContactFormStatus.Error ? (
        <Alert variant="destructive">
          <AlertTitle>{copy.errorTitle}</AlertTitle>
          <AlertDescription>{copy.errorBody}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-6 sm:grid-cols-2">
        {TEXT_FIELDS.map(({ field, type, autoComplete }) => (
          <div
            className={
              field === ContactFormField.EngineerCount
                ? "flex flex-col gap-2 sm:col-span-2"
                : "flex flex-col gap-2"
            }
            key={field}
          >
            <Label htmlFor={fieldId(field)}>{FIELD_LABEL[field]}</Label>
            <Input
              aria-invalid={invalidFields.includes(field)}
              autoComplete={autoComplete}
              disabled={isSubmitting}
              id={fieldId(field)}
              inputMode={
                field === ContactFormField.EngineerCount ? "numeric" : undefined
              }
              name={field}
              onChange={(event) => setField(field, event.target.value)}
              required
              type={type}
              value={values[field]}
            />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={fieldId(ContactFormField.Message)}>
          {FIELD_LABEL[ContactFormField.Message]}
        </Label>
        <Textarea
          aria-invalid={invalidFields.includes(ContactFormField.Message)}
          disabled={isSubmitting}
          id={fieldId(ContactFormField.Message)}
          name={ContactFormField.Message}
          onChange={(event) =>
            setField(ContactFormField.Message, event.target.value)
          }
          required
          rows={6}
          value={values[ContactFormField.Message]}
        />
      </div>
      <div>
        <Button disabled={isSubmitting} type="submit">
          {isSubmitting ? copy.submittingLabel : copy.submitLabel}
        </Button>
      </div>
    </form>
  );
};
