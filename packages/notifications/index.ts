import { Knock } from "@knocklabs/node";
import { keys } from "./keys";

export const notifications = new Knock({
  apiKey: keys().KNOCK_SECRET_API_KEY,
});
