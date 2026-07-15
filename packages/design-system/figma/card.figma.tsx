import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@closedloop-ai/design-system/components/ui/card";
import figma from "@figma/code-connect";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=149-2500";

figma.connect(Card, FIGMA_URL, {
  props: {
    title: figma.string("Title"),
    description: figma.string("Description"),
    content: figma.children("Content"),
    footer: figma.children("Footer"),
  },
  example: ({ title, description, content, footer }) => (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{content}</CardContent>
      <CardFooter>{footer}</CardFooter>
    </Card>
  ),
});
