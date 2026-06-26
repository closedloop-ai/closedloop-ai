import figma from "@figma/code-connect";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
} from "@repo/design-system/components/ui/breadcrumb";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=6727-5792";

figma.connect(Breadcrumb, FIGMA_URL, {
  props: {
    items: figma.children("Items"),
  },
  example: ({ items }) => (
    <Breadcrumb>
      <BreadcrumbList>{items}</BreadcrumbList>
    </Breadcrumb>
  ),
});

const ITEM_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=6727-5796";

figma.connect(BreadcrumbItem, ITEM_URL, {
  props: {
    label: figma.string("Label"),
  },
  example: ({ label }) => (
    <BreadcrumbItem>
      <BreadcrumbLink href="#">{label}</BreadcrumbLink>
    </BreadcrumbItem>
  ),
});
