import { type ApiData, verifyAccess } from "flags";
import { type NextRequest, NextResponse } from "next/server";
import { showBetaFeature } from "./index";

const allFlags = [showBetaFeature];

export const getFlags = async (request: NextRequest) => {
  const access = await verifyAccess(request.headers.get("Authorization"));

  if (!access) {
    return NextResponse.json(null, { status: 401 });
  }

  const definitions = Object.fromEntries(
    allFlags.map((flag) => [
      flag.key,
      {
        origin: flag.origin,
        description: flag.description,
        options: flag.options,
      },
    ])
  );

  return NextResponse.json<ApiData>({
    definitions,
  });
};
