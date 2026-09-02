import { createHash, createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const transaction = {
    devicePairing: { findUnique: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    workspace: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    workspaceMember: { upsert: vi.fn() }
  };
  return {
    transaction,
    runTransaction: vi.fn(async (callback: (value: typeof transaction) => unknown) =>
      callback(transaction)
    )
  };
});

vi.mock("@app/db", () => ({
  prisma: { $transaction: database.runTransaction }
}));

import {
  readCentralAuthIdentity,
  resolveCentralAuthIdentity
} from "./central-auth";

const secret = "central-auth-test-secret-at-least-32-characters";

function assertion(overrides: Record<string, unknown> = {}) {
  const payload = Buffer.from(JSON.stringify({
    kind: "authz-assertion",
    aud: "wowdata-project.v1",
    project_id: "auto-ux",
    open_id: "ou_test_identity",
    name: "测试用户",
    exp: 1_800_000_000,
    ...overrides
  })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

describe("central auth assertion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts a valid project-scoped assertion", () => {
    const request = new Request("https://wowdata.example/auto-ux/", {
      headers: { "x-wowdata-assertion": assertion() }
    });

    expect(
      readCentralAuthIdentity(request, secret, "auto-ux", new Date(1_700_000_000_000))
    ).toEqual({
      openId: "ou_test_identity",
      name: "测试用户",
      projectId: "auto-ux"
    });
  });

  it("rejects forged, expired, or wrong-project assertions", () => {
    const now = new Date(1_700_000_000_000);
    const request = (value: string) => new Request("https://wowdata.example/auto-ux/", {
      headers: { "x-wowdata-assertion": value }
    });

    expect(readCentralAuthIdentity(request(`${assertion()}0`), secret, "auto-ux", now)).toBeNull();
    expect(readCentralAuthIdentity(request(assertion({ exp: 1_600_000_000 })), secret, "auto-ux", now)).toBeNull();
    expect(readCentralAuthIdentity(request(assertion({ project_id: "other" })), secret, "auto-ux", now)).toBeNull();
  });

  it("claims only the legacy scope proven by the paired-browser token", async () => {
    const legacyUser = {
      id: "User_legacy",
      feishuTenantKey: null,
      feishuUnionId: null,
      feishuOpenId: null
    };
    const legacyWorkspace = {
      id: "Workspace_legacy",
      feishuTenantKey: null
    };
    database.transaction.user.findUnique.mockResolvedValue(null);
    database.transaction.workspace.findUnique.mockResolvedValue(null);
    database.transaction.devicePairing.findUnique.mockResolvedValue({
      userId: legacyUser.id,
      workspaceId: legacyWorkspace.id,
      claimedAt: new Date("2026-09-01T00:00:00.000Z"),
      user: legacyUser,
      workspace: legacyWorkspace
    });
    database.transaction.user.update.mockResolvedValue(legacyUser);
    database.transaction.workspace.update.mockResolvedValue(legacyWorkspace);
    const browserToken = `browser_token:${"a".repeat(64)}`;

    const user = await resolveCentralAuthIdentity(
      { openId: "ou_1", name: "用户一", projectId: "auto-ux" },
      browserToken
    );

    expect(user).toEqual({
      userId: legacyUser.id,
      workspaceId: legacyWorkspace.id,
      name: "用户一",
      avatarUrl: null
    });
    expect(database.transaction.devicePairing.findUnique).toHaveBeenCalledWith({
      where: {
        browserTokenHash: createHash("sha256").update(browserToken).digest("hex")
      },
      include: { user: true, workspace: true }
    });
    expect(database.transaction.user.update).toHaveBeenCalledWith({
      where: { id: legacyUser.id },
      data: expect.objectContaining({
        feishuTenantKey: "wowdata-central",
        feishuOpenId: "ou_1"
      })
    });
    expect(database.transaction.workspace.update).toHaveBeenCalledWith({
      where: { id: legacyWorkspace.id },
      data: {
        feishuTenantKey: expect.stringMatching(/^wowdata-central:[a-f0-9]{64}$/)
      }
    });
  });

  it("does not inspect a legacy pairing after the identity already exists", async () => {
    database.transaction.user.findUnique.mockResolvedValue({ id: "User_bound" });
    database.transaction.workspace.findUnique.mockResolvedValue({
      id: "Workspace_bound"
    });
    database.transaction.user.update.mockResolvedValue({ id: "User_bound" });
    database.transaction.workspaceMember.upsert.mockResolvedValue({});

    const user = await resolveCentralAuthIdentity(
      { openId: "ou_1", name: "用户一", projectId: "auto-ux" },
      `browser_token:${"b".repeat(64)}`
    );

    expect(user.userId).toBe("User_bound");
    expect(user.workspaceId).toBe("Workspace_bound");
    expect(database.transaction.devicePairing.findUnique).not.toHaveBeenCalled();
  });
});
