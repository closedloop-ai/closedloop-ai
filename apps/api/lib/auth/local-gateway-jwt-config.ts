export const LOCAL_GATEWAY_CHALLENGE_TTL_SECONDS = 60;
export const LOCAL_GATEWAY_JWT_MIN_SECRET_LENGTH = 32;
export const LOCAL_GATEWAY_JWT_MIN_UNIQUE_SECRET_CHARS = 8;

export function hasStrongLocalGatewayJwtSecret(secret: string): boolean {
  return (
    secret.length >= LOCAL_GATEWAY_JWT_MIN_SECRET_LENGTH &&
    new Set(secret).size >= LOCAL_GATEWAY_JWT_MIN_UNIQUE_SECRET_CHARS
  );
}
