import { NextResponse } from "next/server";

export function GET() {
  const apiKey = process.env.CLOSEDLOOP_API_KEY ?? "";
  return NextResponse.json({ apiKey });
}
