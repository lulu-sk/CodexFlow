import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClaudeUsageSnapshotAsync } from "./usage";

let tempRoot: string;
let fetchMock: ReturnType<typeof vi.fn>;

/** 写入带可选 BOM 的去标识化 Claude 凭据或缓存。 */
async function writeFixture(relativePath: string, value: unknown): Promise<void> {
  const target = path.join(tempRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "\uFEFF" + JSON.stringify(value), "utf8");
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexflow-claude-usage-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", tempRoot);
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await getClaudeUsageSnapshotAsync({ terminal: "windows" }).catch(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("Claude 用量", () => {
  it("Windows 使用官方接口，分别保留五小时与周窗口的重置时间", async () => {
    await writeFixture(".credentials.json", { claudeAiOauth: { accessToken: "test-token", expiresAt: Date.now() + 60_000 } });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      five_hour: { utilization: 20, resets_at: "2026-02-01T10:00:00Z" },
      seven_day: { utilization: 30, resets_at: "2026-02-05T10:00:00Z" },
      seven_day_opus: null,
    })));
    const result = await getClaudeUsageSnapshotAsync({ terminal: "pwsh" });
    expect(result.source).toBe("oauth-api");
    expect(result.windows.fiveHour).toMatchObject({ usedPercent: 20, remainingPercent: 80, resetAt: Date.parse("2026-02-01T10:00:00Z") });
    expect(result.windows.sevenDay.resetAt).toBe(Date.parse("2026-02-05T10:00:00Z"));
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(fetchMock.mock.calls[0][1].headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("缺失或 null 的百分比保持未知，不显示零消耗", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "test-token");
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ five_hour: null, seven_day: { utilization: 0 } })));
    const result = await getClaudeUsageSnapshotAsync({ terminal: "cmd" });
    expect(result.windows.fiveHour.usedPercent).toBeNull();
    expect(result.windows.sevenDay.usedPercent).toBe(0);
  });

  it("不能把没有账号归属的 ccline 缓存认作当前账号用量", async () => {
    await writeFixture("ccline/.api_usage_cache.json", { five_hour_utilization: 15, cached_at: new Date().toISOString() });
    await expect(getClaudeUsageSnapshotAsync({ terminal: "windows" })).rejects.toThrow("用量信息不可用");
  });

  it("网络瞬断只复用同一凭据五分钟内的成功用量", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "test-token");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ five_hour: { utilization: 15 } })));
    const fresh = await getClaudeUsageSnapshotAsync({ terminal: "windows" });
    fetchMock.mockRejectedValue(new Error("offline"));
    const cached = await getClaudeUsageSnapshotAsync({ terminal: "windows" });
    expect(cached).toMatchObject({ source: "oauth-api-cache", cachedAt: fresh.collectedAt, windows: { fiveHour: { usedPercent: 15 }, sevenDay: { usedPercent: null } } });
    vi.spyOn(Date, "now").mockReturnValue(fresh.collectedAt + 6 * 60_000);
    await expect(getClaudeUsageSnapshotAsync({ terminal: "windows" })).rejects.toThrow("offline");
  });

  it("切换凭据或登录失效不能复用旧账号的成功用量", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "first-token");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ five_hour: { utilization: 15 } })));
    await getClaudeUsageSnapshotAsync({ terminal: "windows" });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(getClaudeUsageSnapshotAsync({ terminal: "windows" })).rejects.toThrow("HTTP 401");
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(getClaudeUsageSnapshotAsync({ terminal: "windows" })).rejects.toThrow("offline");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "second-token");
    await expect(getClaudeUsageSnapshotAsync({ terminal: "windows" })).rejects.toThrow("offline");
  });

  it("已过期凭据不能被未绑定的磁盘缓存掩盖", async () => {
    await writeFixture(".credentials.json", { claudeAiOauth: { accessToken: "expired-token", expiresAt: Date.now() - 1 } });
    await writeFixture("ccline/.api_usage_cache.json", { five_hour_utilization: 15, cached_at: new Date().toISOString() });
    await expect(getClaudeUsageSnapshotAsync({ terminal: "windows" })).rejects.toThrow("登录凭据已过期");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("接口错误或无有效额度不能返回成功", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "test-token");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(getClaudeUsageSnapshotAsync({ terminal: "pwsh" })).rejects.toThrow("HTTP 401");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ five_hour: { utilization: null }, seven_day: null })));
    await expect(getClaudeUsageSnapshotAsync({ terminal: "pwsh" })).rejects.toThrow("未返回有效额度");
  });
});
