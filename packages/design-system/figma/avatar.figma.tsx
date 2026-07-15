import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@closedloop-ai/design-system/components/ui/avatar";
import figma from "@figma/code-connect";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=8-297";

figma.connect(Avatar, FIGMA_URL, {
  props: {
    fallback: figma.string("Fallback"),
  },
  example: ({ fallback }) => (
    <Avatar>
      <AvatarImage alt="Avatar" src="https://github.com/shadcn.png" />
      <AvatarFallback>{fallback}</AvatarFallback>
    </Avatar>
  ),
});
