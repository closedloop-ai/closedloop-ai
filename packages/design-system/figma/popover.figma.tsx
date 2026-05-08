import figma from "@figma/code-connect";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/ClosedLoop-Design-System?node-id=13-888";

figma.connect(PopoverContent, FIGMA_URL, {
  props: {
    content: figma.children("Content"),
  },
  example: ({ content }) => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">Open</Button>
      </PopoverTrigger>
      <PopoverContent>{content}</PopoverContent>
    </Popover>
  ),
});
