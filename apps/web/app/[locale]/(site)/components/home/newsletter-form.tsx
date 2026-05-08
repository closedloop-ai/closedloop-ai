"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { CheckCircle2 } from "lucide-react";
import { type FormEvent, useState } from "react";

export const NewsletterForm = () => {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email) {
      return;
    }
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-border/60 bg-background/60 p-4 text-muted-foreground text-sm">
        <CheckCircle2 className="size-4 text-primary" />
        <span>Thanks — we&apos;ll be in touch.</span>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3 sm:flex-row"
      noValidate
      onSubmit={onSubmit}
    >
      <Input
        aria-label="Email address"
        className="h-10 flex-1"
        name="email"
        onChange={(event) => setEmail(event.target.value)}
        placeholder="Enter your email"
        required
        type="email"
        value={email}
      />
      <Button size="lg" type="submit">
        Subscribe
      </Button>
    </form>
  );
};
