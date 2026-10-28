import type { IncomingMessage, ServerResponse } from "node:http";

export type HttpRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse
) => void | Promise<void>;
