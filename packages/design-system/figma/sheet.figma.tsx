import figma from "@figma/code-connect";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@closedloop-ai/design-system/components/ui/sheet";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=2785-10044";

figma.connect(SheetContent, FIGMA_URL, {
  props: {
    title: figma.string("Title"),
    description: figma.string("Description"),
    side: figma.enum("Side", {
      Right: "right",
      Left: "left",
      Top: "top",
      Bottom: "bottom",
    }),
    content: figma.children("Content"),
  },
  example: ({ title, description, side, content }) => (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">Open</Button>
      </SheetTrigger>
      <SheetContent side={side}>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {content}
        <SheetFooter>
          <Button type="submit">Save</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  ),
});
