"use client";

import { ContactFormDemo } from "@repo/app/marketing/contact/components/contact-form-demo";
import { mockProps } from "./mock";

const WebContactFormPrototypePage = () => (
  <main>
    <ContactFormDemo {...mockProps} />
  </main>
);

export default WebContactFormPrototypePage;
