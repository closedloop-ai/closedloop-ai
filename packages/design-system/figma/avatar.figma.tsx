import figma from "@figma/code-connect";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/ClosedLoop-Design-System?node-id=8-297";

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
