import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const discoveryMocks = vi.hoisted(() => ({
  getGrokRootCandidatesFastAsync: vi.fn(),
}));

vi.mock("../agentSessions/grok/discovery", () => discoveryMocks);

import { __grokUsageTest, getGrokUsageSnapshotAsync } from "./usage";

let tempRoot = "";
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codexflow-grok-usage-"));
  discoveryMocks.getGrokRootCandidatesFastAsync.mockReset();
  discoveryMocks.getGrokRootCandidatesFastAsync.mockResolvedValue([
    { path: path.join(tempRoot, "sessions"), exists: false, source: "windows", kind: "local" },
  ]);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (tempRoot) await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

/**
 * 写入去标识化的 Grok 认证测试夹具。
 */
async function writeAuthFixture(
  home: string,
  mode: "oidc" | "api_key",
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await fs.promises.mkdir(home, { recursive: true });
  const scope = mode === "oidc" ? "https://auth.x.ai::test-client" : "xai::api_key";
  await fs.promises.writeFile(path.join(home, "auth.json"), JSON.stringify({
    [scope]: {
      key: "test-token",
      auth_mode: mode,
      user_id: "test-user",
      email: "user@example.test",
      oidc_issuer: mode === "oidc" ? "https://auth.x.ai" : undefined,
      ...overrides,
    },
  }), "utf8");
}

/**
 * 让模拟 billing 接口返回指定 JSON 数据。
 */
function mockBillingResponse(data: unknown, status = 200): void {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

/**
 * 写入一条 Grok 官方额度缓存日志。
 */
async function writeBillingLogFixture(home: string, ctx: unknown): Promise<void> {
  const logDir = path.join(home, "logs");
  await fs.promises.mkdir(logDir, { recursive: true });
  await fs.promises.writeFile(path.join(logDir, "unified.jsonl"), JSON.stringify({
    ts: "2026-01-02T03:04:05.000Z",
    src: "shell",
    lvl: "info",
    msg: "billing: fetched credits config",
    ctx,
  }) + "\n", "utf8");
}

describe("getGrokUsageSnapshotAsync", () => {
  it("通过官方 OAuth 接口读取新版账号额度", async () => {
    await writeAuthFixture(tempRoot, "oidc");
    mockBillingResponse({
      config: {
        creditUsagePercent: 42.5,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-01-01T00:00:00Z",
          end: "2026-01-08T00:00:00Z",
        },
        onDemandCap: { val: 2500 },
        onDemandUsed: { val: 350 },
        prepaidBalance: { val: 1200 },
        isUnifiedBillingUser: true,
      },
      onDemandEnabled: true,
      subscriptionTier: "SuperGrok",
    });

    const snapshot = await getGrokUsageSnapshotAsync({ terminal: "pwsh" });

    expect(snapshot).toMatchObject({
      providerId: "grok",
      source: "billing-api",
      accountEmail: "user@example.test",
      subscriptionTier: "SuperGrok",
      quota: {
        usedPercent: 42.5,
        periodType: "USAGE_PERIOD_TYPE_WEEKLY",
        periodStartAt: Date.parse("2026-01-01T00:00:00Z"),
        periodEndAt: Date.parse("2026-01-08T00:00:00Z"),
        onDemandEnabled: true,
        onDemandCapCents: 2500,
        onDemandUsedCents: 350,
        prepaidBalanceCents: 1200,
        isUnifiedBillingUser: true,
      },
    });
    const request = fetchMock.mock.calls[0];
    expect(request[0]).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    expect(request[1].headers).toMatchObject({
      Authorization: "Bearer test-token",
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-userid": "test-user",
      "x-grok-client-mode": "interactive",
    });
  });

  it("兼容旧版金额字段并计算账号额度百分比", async () => {
    await writeAuthFixture(tempRoot, "oidc");
    mockBillingResponse({
      config: {
        monthlyLimit: { val: 2000 },
        used: { val: 500 },
        billingPeriodStart: "2026-02-01T00:00:00Z",
        billingPeriodEnd: "2026-03-01T00:00:00Z",
      },
    });

    const snapshot = await getGrokUsageSnapshotAsync({ terminal: "windows" });

    expect(snapshot.quota).toMatchObject({
      usedPercent: 25,
      includedUsedCents: 500,
      includedLimitCents: 2000,
      periodStartAt: Date.parse("2026-02-01T00:00:00Z"),
      periodEndAt: Date.parse("2026-03-01T00:00:00Z"),
    });
  });

  it("WSL 模式只读取指定发行版的 Grok 认证", async () => {
    const wslHome = path.join(tempRoot, "wsl-home");
    await writeAuthFixture(wslHome, "oidc");
    discoveryMocks.getGrokRootCandidatesFastAsync.mockResolvedValue([
      { path: path.join(tempRoot, "windows-home", "sessions"), exists: false, source: "windows", kind: "local" },
      { path: path.join(wslHome, "sessions"), exists: false, source: "wsl", kind: "unc", distro: "TestDistro" },
      { path: path.join(tempRoot, "other-home", "sessions"), exists: false, source: "wsl", kind: "unc", distro: "OtherDistro" },
    ]);
    mockBillingResponse({ config: { creditUsagePercent: 10 } });

    const snapshot = await getGrokUsageSnapshotAsync({ terminal: "wsl", distro: "TestDistro" });

    expect(snapshot.quota.usedPercent).toBe(10);
  });

  it("API Key 登录明确返回账号额度不受支持", async () => {
    await writeAuthFixture(tempRoot, "api_key");

    await expect(getGrokUsageSnapshotAsync({ terminal: "cmd" }))
      .rejects.toThrow("GROK_USAGE_API_KEY_UNSUPPORTED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("团队 OAuth 登录遵循官方规则隐藏消费者额度", async () => {
    await writeAuthFixture(tempRoot, "oidc", { team_id: "test-team" });

    await expect(getGrokUsageSnapshotAsync({ terminal: "pwsh" }))
      .rejects.toThrow("GROK_USAGE_TEAM_UNSUPPORTED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("实时请求失败时回退到 Grok 官方额度日志", async () => {
    await writeAuthFixture(tempRoot, "oidc");
    await writeBillingLogFixture(tempRoot, {
      config: {
        creditUsagePercent: 67,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "2026-04-01T00:00:00Z" },
        prepaidBalance: {},
      },
      subscriptionTier: "SuperGrok Heavy",
    });
    fetchMock.mockRejectedValue(new Error("offline"));

    const snapshot = await getGrokUsageSnapshotAsync({ terminal: "pwsh" });

    expect(snapshot).toMatchObject({
      source: "billing-cache",
      updatedAt: Date.parse("2026-01-02T03:04:05.000Z"),
      subscriptionTier: "SuperGrok Heavy",
      quota: {
        usedPercent: 67,
        periodType: "USAGE_PERIOD_TYPE_MONTHLY",
        prepaidBalanceCents: 0,
      },
    });
  });

  it("无有效 OAuth 登录时返回登录提示错误", async () => {
    await fs.promises.writeFile(path.join(tempRoot, "auth.json"), "{invalid", "utf8");

    await expect(getGrokUsageSnapshotAsync({ terminal: "pwsh" }))
      .rejects.toThrow("GROK_USAGE_AUTH_REQUIRED");
  });
});

describe("__grokUsageTest", () => {
  it("新版百分比优先于旧版金额推导结果", () => {
    const snapshot = __grokUsageTest.parseBillingSnapshot({
      config: {
        creditUsagePercent: 12,
        used: { val: 900 },
        monthlyLimit: { val: 1000 },
      },
    }, "billing-api", 1, null);

    expect(snapshot?.quota.usedPercent).toBe(12);
  });
});
