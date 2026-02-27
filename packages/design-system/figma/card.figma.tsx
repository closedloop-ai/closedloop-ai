import figma from "@figma/code-connect";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/ClosedLoop-Design-System?node-id=149-2500";

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
