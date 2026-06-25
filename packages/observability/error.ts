export const parseError = (error: unknown): string => {
  let message: string;

  if (error instanceof Error) {
    message = error.message;
  } else if (error && typeof error === "object" && "message" in error) {
    message =
      typeof error.message === "string" ? error.message : String(error.message);
  } else {
    message = String(error);
  }

  return message;
};
