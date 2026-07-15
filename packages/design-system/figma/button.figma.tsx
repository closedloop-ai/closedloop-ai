import figma from "@figma/code-connect";
import { Button } from "@closedloop-ai/design-system/components/ui/button";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=6716-46634";

figma.connect(Button, FIGMA_URL, {
  props: {
    children: figma.string("Label"),
    disabled: figma.boolean("Disabled"),
    variant: figma.enum("Variant", {
      Primary: "default",
      Secondary: "secondary",
      Destructive: "destructive",
      Outline: "outline",
      Ghost: "ghost",
      Link: "link",
    }),
    size: figma.enum("Size", {
      Default: "default",
      Small: "sm",
      Large: "lg",
      Icon: "icon",
    }),
  },
  example: ({ children, disabled, variant, size }) => (
    <Button disabled={disabled} size={size} variant={variant}>
      {children}
    </Button>
  ),
});
