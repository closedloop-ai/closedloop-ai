export type HttpRouteHandler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
) => void | Promise<void>;
