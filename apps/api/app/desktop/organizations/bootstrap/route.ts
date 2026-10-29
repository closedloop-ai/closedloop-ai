import "server-only";

import {
  DesktopBootstrapErrorCode,
  desktopBootstrapLogoReferenceSchema,
  desktopBootstrapOrganizationHttpRequestSchema,
} from "@repo/api/src/types/desktop-bootstrap";
import {
  desktopContractError,
  desktopContractSuccess,
} from "@/app/desktop/contract";
import {
  DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES,
  readBoundedJsonBody,
} from "@/app/desktop/route-helpers";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { desktopBootstrapSchemaReadinessService } from "../../bootstrap-authorize/schema-readiness-service";
import { desktopBootstrapLogoService } from "./logo-service";
import { desktopBootstrapOrganizationService } from "./service";

const requestValidator = desktopBootstrapOrganizationHttpRequestSchema;

export const POST = createDesktopBootstrapOrganizationHandler();
export const PUT = createDesktopBootstrapLogoUploadHandler();

async function handlePost(request: Request) {
  const authorization = request.headers.get("authorization");
  const bootstrapToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;
  if (!bootstrapToken) {
    return desktopContractError(
      401,
      DesktopBootstrapErrorCode.BootstrapRequired,
      false
    );
  }
  const { rawBody } = await readBoundedJsonBody(
    request,
    DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES
  );
  const parsed = requestValidator.safeParse(rawBody);
  if (!parsed.success) {
    return desktopContractError(
      400,
      DesktopBootstrapErrorCode.OrganizationInvalidBody,
      false
    );
  }
  if (!(await desktopBootstrapSchemaReadinessService.isReady())) {
    return desktopContractError(
      503,
      DesktopBootstrapErrorCode.OrganizationFailed,
      true
    );
  }
  const result = await desktopBootstrapOrganizationService
    .create({ bootstrapToken, ...parsed.data })
    .catch(() => null);
  if (!result) {
    return desktopContractError(
      503,
      DesktopBootstrapErrorCode.OrganizationFailed,
      true
    );
  }
  if (!result.ok) {
    const conflict =
      result.error === "already_used" || result.error === "organization_exists";
    return desktopContractError(
      conflict ? 409 : 401,
      conflict
        ? DesktopBootstrapErrorCode.OrganizationAlreadyExists
        : DesktopBootstrapErrorCode.BootstrapInvalid,
      false
    );
  }
  return desktopContractSuccess(result.value);
}

function createDesktopBootstrapOrganizationHandler() {
  return withRequestCompleted(handlePost);
}

function createDesktopBootstrapLogoUploadHandler() {
  return withRequestCompleted(async (request: Request) => {
    const authorization = request.headers.get("authorization");
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : null;
    if (!token) {
      return desktopContractError(
        401,
        DesktopBootstrapErrorCode.BootstrapRequired,
        false
      );
    }
    const { rawBody } = await readBoundedJsonBody(
      request,
      DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES
    );
    const parsed = desktopBootstrapLogoReferenceSchema.safeParse(rawBody);
    if (!parsed.success) {
      return desktopContractError(
        400,
        DesktopBootstrapErrorCode.OrganizationInvalidBody,
        false
      );
    }
    if (!(await desktopBootstrapSchemaReadinessService.isReady())) {
      return desktopContractError(
        503,
        DesktopBootstrapErrorCode.OrganizationFailed,
        true
      );
    }
    const result = await desktopBootstrapLogoService
      .authorize(token, parsed.data)
      .catch(() => null);
    if (!result) {
      return desktopContractError(
        503,
        DesktopBootstrapErrorCode.OrganizationFailed,
        true
      );
    }
    if (!result.ok) {
      return desktopContractError(
        401,
        DesktopBootstrapErrorCode.BootstrapInvalid,
        false
      );
    }
    return desktopContractSuccess(result.value);
  });
}
