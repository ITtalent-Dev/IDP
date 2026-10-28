import { beforeEach, describe, expect, it } from "vitest";
import { agent, resetDb, setupOrgWithOwner, type Agent } from "./helpers";
import { getAccessToken, seedTestClients } from "./helpers/oauth";
import { MAX_MEMBER_IDS } from "../server/lib/member-directory";

const userIdOf = async (user: Agent): Promise<string> =>
  (await user.get("/api/auth/get-session").expect(200)).body.user.id;

const appTokenOf = async (user: Agent, clients: Awaited<ReturnType<typeof seedTestClients>>) =>
  (await getAccessToken(user, clients.app)).body.access_token as string;

const members = (token: string | undefined, ids: string[]) => {
  const request = agent()
    .get("/api/organization/members")
    .query({ ids: ids.join(",") });

  return token ? request.set("Authorization", `Bearer ${token}`) : request;
};

describe("member directory for apps", () => {
  beforeEach(resetDb);

  it("returns only the id and name of members of the token organization", async () => {
    const clients = await seedTestClients();
    const first = await setupOrgWithOwner(["app"]);
    const second = await setupOrgWithOwner(["app"]);
    const firstOwnerId = await userIdOf(first.owner);
    const secondOwnerId = await userIdOf(second.owner);

    const res = await members(await appTokenOf(first.owner, clients), [firstOwnerId, secondOwnerId, "unknown"]);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.members).toEqual([{ id: firstOwnerId, name: "Invited" }]);
  });

  it("rejects requests without a valid app token", async () => {
    const first = await setupOrgWithOwner(["app"]);
    const ownerId = await userIdOf(first.owner);

    await members(undefined, [ownerId]).expect(401);
    await members("not-a-token", [ownerId]).expect(401);
    await first.owner.get("/api/organization/members").query({ ids: ownerId }).expect(401);
  });

  it("refuses an empty or oversized list of ids", async () => {
    const clients = await seedTestClients();
    const first = await setupOrgWithOwner(["app"]);
    const token = await appTokenOf(first.owner, clients);
    const tooMany = Array.from({ length: MAX_MEMBER_IDS + 1 }, (_, i) => `user-${i}`);

    await members(token, []).expect(400);
    await members(token, tooMany).expect(400);
  });
});
