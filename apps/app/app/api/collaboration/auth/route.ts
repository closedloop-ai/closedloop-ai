import type { ApiResult } from "@repo/api/src/types/common";
import type { User } from "@repo/api/src/types/organization";
import { auth } from "@repo/auth/server";
import { authenticate } from "@repo/collaboration/auth";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import z from "zod";
import { env } from "@/env";

export const POST = async (request: Request) => {
  try {
    const { userId, getToken } = await auth();

    if (!userId) {
      return new Response("Unauthorized", { status: 401 });
    }

    const { room: roomId } = await authenticateValidator.parseAsync(
      await request.json()
    );

    const user = await fetchUser(getToken);
    if (!user) {
      return new Response("Unable to fetch user", { status: 500 });
    }

    const result = validateRoomId(roomId, user.organizationId);
    if (!result.success) {
      log.error("Invalid room ID", {
        roomId,
        user,
        error: result.error,
      });
      return new Response(result.error, { status: result.status });
    }

    const { token, status } = await authenticate({
      userId,
      roomId,
      userInfo: {
        name: getUserName(user),
        avatar: user.avatarUrl ?? undefined,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      },
    });

    return new Response(token, { status });
  } catch (error) {
    log.error("Collaboration auth error", { error: parseError(error) });
    return new Response("Unable to authenticate", { status: 500 });
  }
};

const authenticateValidator = z.object({
  room: z.string().min(1, "room is required"),
});

function validateRoomId(
  roomId: string,
  orgId: string
): { success: true } | { success: false; error: string; status: number } {
  // Liveblocks room ID format: orgId:type:id
  const idParts = roomId.split(":");
  if (idParts.length !== 3) {
    return { success: false, error: `Invalid room ID: ${roomId}`, status: 400 };
  }
  const [roomOrgId, roomType] = idParts;
  if (roomOrgId !== orgId) {
    return { success: false, error: "Forbidden", status: 403 };
  }
  if (roomType !== "artifact") {
    return {
      success: false,
      error: `Invalid room type: ${roomType}`,
      status: 400,
    };
  }
  return { success: true };
}

async function fetchUser(
  getToken: () => Promise<string | null>
): Promise<User | null> {
  if (!env.NEXT_PUBLIC_API_URL) {
    log.error("NEXT_PUBLIC_API_URL is not set");
    return null;
  }

  try {
    const token = await getToken();
    if (!token) {
      log.error("Unable to fetch auth token");
      return null;
    }

    const response = await fetch(`${env.NEXT_PUBLIC_API_URL}/me`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      log.error("Unable to fetch user", { status: response.status });
      return null;
    }

    const result = (await response.json()) as ApiResult<User>;
    if (!result.success) {
      log.error("Unable to fetch user", { error: result.error });
      return null;
    }

    return result.data;
  } catch (error) {
    log.error("Error fetching user", { error: parseError(error) });
    return null;
  }
}

function getUserName(user: User): string {
  if (user.firstName && user.lastName) {
    return `${user.firstName} ${user.lastName}`;
  }
  if (user.firstName) {
    return user.firstName;
  }
  if (user.email) {
    return user.email;
  }
  return "Anonymous";
}

const COLORS = [
  "var(--color-red-500)",
  "var(--color-orange-500)",
  "var(--color-amber-500)",
  "var(--color-yellow-500)",
  "var(--color-lime-500)",
  "var(--color-green-500)",
  "var(--color-emerald-500)",
  "var(--color-teal-500)",
  "var(--color-cyan-500)",
  "var(--color-sky-500)",
  "var(--color-blue-500)",
  "var(--color-indigo-500)",
  "var(--color-violet-500)",
  "var(--color-purple-500)",
  "var(--color-fuchsia-500)",
  "var(--color-pink-500)",
  "var(--color-rose-500)",
];
