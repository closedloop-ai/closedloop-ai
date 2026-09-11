import { zodResolver } from "@hookform/resolvers/zod";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@repo/design-system/components/ui/form";
import type { Meta, StoryObj } from "@storybook/react";
import { useForm } from "react-hook-form";
import { action } from "storybook/actions";
import { z } from "zod";

/**
 * A set of building blocks for a form: a label, the input itself, helper
 * text underneath, and an error message that only shows up once a field
 * fails validation. It connects to React Hook Form and Zod under the hood,
 * so a field's label, description, and error state stay linked without you
 * wiring up ids by hand. It only supplies the structure. You still bring
 * your own input or other control, and your own validation rules.
 */
const meta: Meta<typeof Form> = {
  title: "Composites/Inputs/Form",
  component: Form,
  tags: ["autodocs"],
  // `Form` is React Hook Form's `FormProvider`, so every prop other than
  // `children` is a live form method or the form state object. None of them are
  // safe to edit from the panel, and the story supplies them from `useForm`.
  argTypes: {
    children: {
      control: false,
      description: "Form fields, supplied by the story render function.",
    },
    control: { control: false, table: { category: "Form API" } },
    formState: { control: false, table: { category: "Form API" } },
    register: { control: false, table: { category: "Form API" } },
    unregister: { control: false, table: { category: "Form API" } },
    handleSubmit: { control: false, table: { category: "Form API" } },
    watch: { control: false, table: { category: "Form API" } },
    subscribe: { control: false, table: { category: "Form API" } },
    getValues: { control: false, table: { category: "Form API" } },
    getFieldState: { control: false, table: { category: "Form API" } },
    setValue: { control: false, table: { category: "Form API" } },
    setValues: { control: false, table: { category: "Form API" } },
    setError: { control: false, table: { category: "Form API" } },
    clearErrors: { control: false, table: { category: "Form API" } },
    setFocus: { control: false, table: { category: "Form API" } },
    trigger: { control: false, table: { category: "Form API" } },
    reset: { control: false, table: { category: "Form API" } },
    resetField: { control: false, table: { category: "Form API" } },
  },
  render: (args) => <ProfileForm {...args} />,
} satisfies Meta<typeof Form>;

export default meta;

type Story = StoryObj<typeof meta>;

const formSchema = z.object({
  username: z.string().min(2, {
    message: "Username must be at least 2 characters.",
  }),
});

const ProfileForm = (args: Story["args"]) => {
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      username: "",
    },
  });
  function onSubmit(values: z.infer<typeof formSchema>) {
    action("onSubmit")(values);
  }
  return (
    <Form {...args} {...form}>
      <form className="space-y-8" onSubmit={form.handleSubmit(onSubmit)}>
        <FormField
          control={form.control}
          name="username"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Username</FormLabel>
              <FormControl>
                <input
                  className="w-full rounded-md border border-input-border bg-background px-3 py-2"
                  placeholder="username"
                  {...field}
                />
              </FormControl>
              <FormDescription>
                This is your public display name.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <button
          className="rounded bg-primary px-4 py-2 text-primary-foreground"
          type="submit"
        >
          Submit
        </button>
      </form>
    </Form>
  );
};

/**
 * The default form of the form.
 */
export const Default: Story = {};
