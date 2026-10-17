import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wslMocks = vi.hoisted(() => ({
  execInWslAsync: vi.fn(),
}));

vi.mock("../wsl", () => wslMocks);

import { __grokUsageTest, getGrokUsageSnapshotAsync } from "./usage";

let tempRoot = "";
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codexflow-grok-usage-"));
  vi.stubEnv("GROK_AUTH_PATH", "");
  vi.stubEnv("GROK_HOME", tempRoot);
  vi.stubEnv("XAI_API_KEY", "");
  vi.stubEnv("GROK_CLI_CHAT_PROXY_BASE_URL", "");
  wslMocks.execInWslAsync.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await getGrokUsageSnapshotAsync({ terminal: "pwsh" }).catch(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
  it("使用 Grok 官方支持的自定义认证文件", async () => {
    const authHome = path.join(tempRoot, "custom-auth");
    await writeAuthFixture(authHome, "oidc");
    vi.stubEnv("GROK_AUTH_PATH", path.join(authHome, "auth.json"));
    mockBillingResponse({ config: { creditUsagePercent: 10 } });
    expect((await getGrokUsageSnapshotAsync({ terminal: "pwsh" })).quota.usedPercent).toBe(10);
  });

  it("登录失效时不能用历史额度掩盖认证错误", async () => {
    await writeAuthFixture(tempRoot, "oidc");
    await writeBillingLogFixture(tempRoot, { config: { creditUsagePercent: 10 } });
    mockBillingResponse({}, 401);
    await expect(getGrokUsageSnapshotAsync({ terminal: "pwsh" })).rejects.toThrow("GROK_USAGE_AUTH_EXPIRED");
  });

  it("认证失效后清除本进程此前确认成功的额度缓存", async () => {
    await writeAuthFixture(tempRoot, "oidc");
    mockBillingResponse({ config: { creditUsagePercent: 10 } });
    await getGrokUsageSnapshotAsync({ terminal: "pwsh" });
    mockBillingResponse({}, 403);
    await expect(getGrokUsageSnapshotAsync({ terminal: "pwsh" })).rejects.toThrow("GROK_USAGE_AUTH_EXPIRED");
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(getGrokUsageSnapshotAsync({ terminal: "pwsh" })).rejects.toThrow("offline");
  });

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

  it("WSL 模式读取指定发行版自己的认证路径与代理设置", async () => {
    const wslHome = path.join(tempRoot, "wsl-home");
    await writeAuthFixture(wslHome, "oidc");
    wslMocks.execInWslAsync.mockResolvedValue("PROXY=https://proxy.example.test/v1\nAPI_KEY=\n" + await fs.promises.readFile(path.join(wslHome, "auth.json"), "utf8"));
    mockBillingResponse({ config: { creditUsagePercent: 10 } });

    const snapshot = await getGrokUsageSnapshotAsync({ terminal: "wsl", distro: "TestDistro" });

    expect(snapshot.quota.usedPercent).toBe(10);
    expect(wslMocks.execInWslAsync).toHaveBeenCalledWith("TestDistro", expect.stringContaining("${GROK_AUTH_PATH:-${GROK_HOME:-$HOME/.grok}/auth.json}"), { timeoutMs: 5000 });
    expect(fetchMock.mock.calls[0][0]).toBe("https://proxy.example.test/v1/billing?format=credits");
  });

  it("未指定发行版时让 WSL 使用系统默认发行版，不能借用 Windows 凭据", async () => {
    await writeAuthFixture(tempRoot, "oidc");
    wslMocks.execInWslAsync.mockResolvedValue("PROXY=\nAPI_KEY=\n");
    await expect(getGrokUsageSnapshotAsync({ terminal: "wsl" })).rejects.toThrow("GROK_USAGE_AUTH_REQUIRED");
    expect(wslMocks.execInWslAsync.mock.calls[0][0]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("实时请求失败时只复用相同凭据五分钟内的成功用量", async () => {
    await writeAuthFixture(tempRoot, "oidc");
    mockBillingResponse({
      config: {
        creditUsagePercent: 67,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "2026-04-01T00:00:00Z" },
        prepaidBalance: {},
      },
      subscriptionTier: "SuperGrok Heavy",
    });
    const fresh = await getGrokUsageSnapshotAsync({ terminal: "pwsh" });
    fetchMock.mockRejectedValue(new Error("offline"));

    const snapshot = await getGrokUsageSnapshotAsync({ terminal: "pwsh" });

    expect(snapshot).toMatchObject({
      source: "billing-cache",
      updatedAt: fresh.updatedAt,
      subscriptionTier: "SuperGrok Heavy",
      quota: {
        usedPercent: 67,
        periodType: "USAGE_PERIOD_TYPE_MONTHLY",
        prepaidBalanceCents: 0,
      },
    });
    vi.spyOn(Date, "now").mockReturnValue(fresh.updatedAt + 6 * 60_000);
    await expect(getGrokUsageSnapshotAsync({ terminal: "pwsh" })).rejects.toThrow("offline");
  });

  it("不能将没有账号归属的官方历史日志认作当前账号额度", async () => {
    await writeAuthFixture(tempRoot, "oidc");
    await writeBillingLogFixture(tempRoot, { config: { creditUsagePercent: 67 } });
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(getGrokUsageSnapshotAsync({ terminal: "pwsh" })).rejects.toThrow("offline");
  });

  it("切换账号后网络失败不能回退到之前账号的用量", async () => {
    await writeAuthFixture(tempRoot, "oidc");
    mockBillingResponse({ config: { creditUsagePercent: 10 } });
    await getGrokUsageSnapshotAsync({ terminal: "pwsh" });
    await writeAuthFixture(tempRoot, "oidc", { user_id: "other-user", key: "other-token" });
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(getGrokUsageSnapshotAsync({ terminal: "pwsh" })).rejects.toThrow("offline");
  });

  it("无有效 OAuth 登录时返回登录提示错误", async () => {
    await fs.promises.writeFile(path.join(tempRoot, "auth.json"), "{invalid", "utf8");

    await expect(getGrokUsageSnapshotAsync({ terminal: "pwsh" }))
      .rejects.toThrow("GROK_USAGE_AUTH_REQUIRED");
  });
});

describe("__grokUsageTest", () => {
  it("兼容接口返回的蛇形套餐字段，异常金额不能变成零", () => {
    const snapshot = __grokUsageTest.parseBillingSnapshot({
      subscription_tier: "SuperGrok", on_demand_enabled: false,
      config: { creditUsagePercent: 10, used: { val: "invalid" }, prepaidBalance: {} },
    }, "billing-api", 1, null);
    expect(snapshot).toMatchObject({ subscriptionTier: "SuperGrok", quota: { onDemandEnabled: false, includedUsedCents: null, prepaidBalanceCents: 0 } });
  });

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
