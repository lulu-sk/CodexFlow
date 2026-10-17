import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const oauthMock = vi.hoisted(() => ({ resolveGeminiOAuthClientConfigAsync: vi.fn(), resolveGeminiUsageUserAgentAsync: vi.fn() }));
vi.mock("./oauthClient", () => oauthMock);
import { getGeminiQuotaSnapshotAsync } from "./usage";

let tempRoot: string;
let fetchMock: ReturnType<typeof vi.fn>;

/** 写入不含本地环境信息的 OAuth 凭据。 */
async function writeCredentials(value: unknown): Promise<void> {
  await fs.writeFile(path.join(tempRoot, ".gemini", "oauth_creds.json"), "\uFEFF" + JSON.stringify(value), "utf8");
}

/** 让一个模拟请求返回 JSON。 */
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexflow-gemini-usage-"));
  await fs.mkdir(path.join(tempRoot, ".gemini"));
  vi.stubEnv("GEMINI_CLI_HOME", tempRoot);
  vi.stubEnv("GEMINI_HOME", "");
  vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
  vi.stubEnv("GOOGLE_CLOUD_PROJECT_ID", "");
  vi.stubEnv("CODE_ASSIST_ENDPOINT", "");
  vi.stubEnv("CODE_ASSIST_API_VERSION", "");
  oauthMock.resolveGeminiOAuthClientConfigAsync.mockReset().mockResolvedValue({ clientId: "test-client", clientSecret: "test-secret" });
  oauthMock.resolveGeminiUsageUserAgentAsync.mockReset().mockResolvedValue("GeminiCLI/1.2.3/usage (test-platform; test-arch; terminal) CodexFlow (usage-query)");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await writeCredentials({ access_token: "test-token", refresh_token: "test-refresh", expiry_date: Date.now() + 3600_000 });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("Gemini 用量", () => {
  it("访问令牌有效时初始化、轮询与额度请求仍发送同一个客户端标识", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonResponse({ allowedTiers: [{ id: "free-tier", isDefault: true }] }))
      .mockResolvedValueOnce(jsonResponse({ name: "operations/test", done: false }))
      .mockResolvedValueOnce(jsonResponse({ done: true, response: { cloudaicompanionProject: { id: "managed-project" } } }))
      .mockResolvedValueOnce(jsonResponse({ buckets: [] }));
    const pending = getGeminiQuotaSnapshotAsync({ terminal: "pwsh" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(oauthMock.resolveGeminiOAuthClientConfigAsync).not.toHaveBeenCalled();
    expect(oauthMock.resolveGeminiUsageUserAgentAsync).toHaveBeenCalledWith({ terminal: "pwsh" });
    expect(fetchMock.mock.calls.map((call) => call[1].method)).toEqual(["POST", "POST", "GET", "POST"]);
    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers["User-Agent"]).toBe("GeminiCLI/1.2.3/usage (test-platform; test-arch; terminal) CodexFlow (usage-query)");
    }
  });

  it("账号需要验证时停止初始化，不能误报成无法识别套餐", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ineligibleTiers: [{ reasonCode: "VALIDATION_REQUIRED", reasonMessage: "Verify account", validationUrl: "https://example.test/verify" }] }));
    await expect(getGeminiQuotaSnapshotAsync({ terminal: "pwsh" })).rejects.toThrow("GEMINI_ACCOUNT_VALIDATION_REQUIRED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("读取自定义主目录，优先显示付费套餐并查询额度", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ currentTier: { id: "free-tier" }, paidTier: { id: "paid-tier" }, cloudaicompanionProject: "test-project" }))
      .mockResolvedValueOnce(jsonResponse({ buckets: [{ remainingFraction: 0.8, modelId: "gemini-test" }] }));
    expect(await getGeminiQuotaSnapshotAsync({ terminal: "pwsh" })).toMatchObject({ projectId: "test-project", tierId: "paid-tier", buckets: [{ remainingFraction: 0.8 }] });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ project: "test-project" });
  });

  it("部分套餐不可用时仍可初始化服务器允许的套餐", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      allowedTiers: [{ id: "free-tier", isDefault: true }],
      ineligibleTiers: [{ reasonCode: "INELIGIBLE_ACCOUNT", reasonMessage: "Other tier unavailable" }],
    })).mockResolvedValueOnce(jsonResponse({ done: true, response: { cloudaicompanionProject: { id: "managed-project" } } }))
      .mockResolvedValueOnce(jsonResponse({ buckets: [] }));
    expect(await getGeminiQuotaSnapshotAsync({ terminal: "pwsh" })).toMatchObject({ projectId: "managed-project", tierId: "free-tier" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("已有套餐缺少项目时保留服务器的资格诊断", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ currentTier: { id: "standard-tier" }, ineligibleTiers: [{ reasonCode: "INELIGIBLE_ACCOUNT", reasonMessage: "Account unavailable" }] }));
    await expect(getGeminiQuotaSnapshotAsync({ terminal: "pwsh" })).rejects.toThrow("GEMINI_TIER_INELIGIBLE: Account unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("凭据过期时使用安装包提供的客户端配置自动刷新", async () => {
    await writeCredentials({ access_token: "expired-token", refresh_token: "test-refresh", expiry_date: Date.now() - 1000 });
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "new-token", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ currentTier: { id: "free-tier" }, cloudaicompanionProject: "test-project" }))
      .mockResolvedValueOnce(jsonResponse({ buckets: [] }));
    await getGeminiQuotaSnapshotAsync({ terminal: "pwsh" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");
    expect(fetchMock.mock.calls[0][1].body.get("client_id")).toBe("test-client");
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe("Bearer new-token");
  });

  it("401 只刷新并重试一次，其他错误不重复请求", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "expired" } }, 401))
      .mockResolvedValueOnce(jsonResponse({ access_token: "new-token", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ currentTier: { id: "free-tier" }, cloudaicompanionProject: "test-project" }))
      .mockResolvedValueOnce(jsonResponse({ buckets: [] }));
    await getGeminiQuotaSnapshotAsync({ terminal: "pwsh" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    fetchMock.mockReset().mockResolvedValue(jsonResponse({ error: { message: "denied" } }, 403));
    await expect(getGeminiQuotaSnapshotAsync({ terminal: "pwsh" })).rejects.toThrow("HTTP 403");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("免费套餐初始化不能提交用户项目", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "test-project");
    fetchMock.mockResolvedValueOnce(jsonResponse({ allowedTiers: [{ id: "free-tier", isDefault: true }] }))
      .mockResolvedValueOnce(jsonResponse({ done: true, response: { cloudaicompanionProject: { id: "managed-project" } } }))
      .mockResolvedValueOnce(jsonResponse({ buckets: [] }));
    const result = await getGeminiQuotaSnapshotAsync({ terminal: "pwsh" });
    const onboard = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(onboard).not.toHaveProperty("cloudaicompanionProject");
    expect(onboard.metadata).not.toHaveProperty("duetProject");
    expect(result.projectId).toBe("managed-project");
  });

  it("轮询响应省略操作名称时继续使用首次返回的名称", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonResponse({ allowedTiers: [{ id: "free-tier", isDefault: true }] }))
      .mockResolvedValueOnce(jsonResponse({ name: "operations/test", done: false }))
      .mockResolvedValueOnce(jsonResponse({ done: false }))
      .mockResolvedValueOnce(jsonResponse({ done: true, response: { cloudaicompanionProject: { id: "managed-project" } } }))
      .mockResolvedValueOnce(jsonResponse({ buckets: [] }));
    const pending = getGeminiQuotaSnapshotAsync({ terminal: "pwsh" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ projectId: "managed-project" });
    expect(fetchMock.mock.calls[2][0]).toBe("https://cloudcode-pa.googleapis.com/v1internal/operations/test");
    expect(fetchMock.mock.calls[3][0]).toBe(fetchMock.mock.calls[2][0]);
  });

  it("初始化轮询遇到 401 时刷新令牌并重试查询", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonResponse({ allowedTiers: [{ id: "free-tier", isDefault: true }] }))
      .mockResolvedValueOnce(jsonResponse({ name: "operations/test", done: false }))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "expired" } }, 401))
      .mockResolvedValueOnce(jsonResponse({ access_token: "new-token", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ currentTier: { id: "free-tier" }, cloudaicompanionProject: "managed-project" }))
      .mockResolvedValueOnce(jsonResponse({ buckets: [] }));
    const pending = getGeminiQuotaSnapshotAsync({ terminal: "pwsh" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ projectId: "managed-project" });
    expect(fetchMock.mock.calls[3][0]).toBe("https://oauth2.googleapis.com/token");
    expect(fetchMock.mock.calls[4][1].headers.authorization).toBe("Bearer new-token");
  });

  it("初始化操作失败时不能拿用户项目误报成功", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "test-project");
    fetchMock.mockResolvedValueOnce(jsonResponse({ allowedTiers: [{ id: "standard-tier", isDefault: true }] }))
      .mockResolvedValueOnce(jsonResponse({ done: true, error: { code: 7, message: "Onboarding denied" } }));
    await expect(getGeminiQuotaSnapshotAsync({ terminal: "pwsh" })).rejects.toThrow("Gemini onboarding 失败：Onboarding denied");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("使用官方支持的接口版本环境变量", async () => {
    vi.stubEnv("CODE_ASSIST_ENDPOINT", "https://example.test");
    vi.stubEnv("CODE_ASSIST_API_VERSION", "v1test");
    fetchMock.mockResolvedValueOnce(jsonResponse({ currentTier: { id: "free-tier" }, cloudaicompanionProject: "test-project" }))
      .mockResolvedValueOnce(jsonResponse({ buckets: [] }));
    await getGeminiQuotaSnapshotAsync({ terminal: "pwsh" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://example.test/v1test:loadCodeAssist");
    expect(fetchMock.mock.calls[1][0]).toBe("https://example.test/v1test:retrieveUserQuota");
  });
});
