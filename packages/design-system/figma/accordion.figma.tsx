import figma from "@figma/code-connect";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@repo/design-system/components/ui/accordion";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/ClosedLoop-Design-System?node-id=7113-55578";

figma.connect(Accordion, FIGMA_URL, {
  props: {
    items: figma.children("Items"),
  },
  example: ({ items }) => (
    <Accordion collapsible type="single">
      {items}
    </Accordion>
  ),
});

const ITEM_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/ClosedLoop-Design-System?node-id=7113-55578";

figma.connect(AccordionItem, ITEM_URL, {
  props: {
    trigger: figma.string("Trigger"),
    content: figma.string("Content"),
  },
  example: ({ trigger, content }) => (
    <AccordionItem value="item-1">
      <AccordionTrigger>{trigger}</AccordionTrigger>
      <AccordionContent>{content}</AccordionContent>
    </AccordionItem>
  ),
});
