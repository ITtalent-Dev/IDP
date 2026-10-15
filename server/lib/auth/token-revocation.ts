import { audit } from "../support/audit";
import { revokeRefreshTokensForSession, revokeRefreshTokensForUser } from "../oauth/revoke-tokens";
import type { HookContext } from "./hook-context";
import { END_SESSIONS_PATH, END_USER_SESSIONS_PATH } from "./end-user-sessions-plugin";

const USER_WIDE_SESSION_PATHS = new Set(["/revoke-sessions", "/change-password", END_USER_SESSIONS_PATH]);
const SINGLE_SESSION_PATHS = new Set([
  "/sign-out",
  "/revoke-session",
  "/revoke-other-sessions",
  "/admin/revoke-user-session",
  END_SESSIONS_PATH,
]);
const USER_WIDE_BODY_PATHS = new Set(["/admin/ban-user", "/admin/revoke-user-sessions", "/admin/set-user-password"]);

async function record(userId: string, count: number, reason: string, actorId: string | null) {
  if (count === 0) return;
  await audit({
    action: "user.tokens.revoke",
    actorId,
    targetType: "user",
    targetId: userId,
    metadata: { reason, count },
  });
}

export async function revokeOnSessionDelete(session: { id: string; userId: string }, ctx: { path?: string } | null) {
  const path = ctx?.path;

  if (!path) return;

  if (USER_WIDE_SESSION_PATHS.has(path)) {
    await record(session.userId, await revokeRefreshTokensForUser(session.userId), path, session.userId);
  } else if (SINGLE_SESSION_PATHS.has(path)) {
    await record(session.userId, await revokeRefreshTokensForSession(session.id), path, null);
  }
}

export async function revokeAfterHook(ctx: HookContext) {
  if ((ctx.context.returned as unknown) instanceof Error) return;

  const body = (ctx.body ?? {}) as { userId?: unknown; data?: { banned?: unknown } };
  const targetsBan = ctx.path === "/admin/update-user" && body.data?.banned === true;

  if (!USER_WIDE_BODY_PATHS.has(ctx.path) && !targetsBan) return;
  if (typeof body.userId !== "string") return;

  await record(body.userId, await revokeRefreshTokensForUser(body.userId), ctx.path, null);
}

export async function revokeOnPasswordReset(userId: string) {
  await record(userId, await revokeRefreshTokensForUser(userId), "/reset-password", userId);
}
