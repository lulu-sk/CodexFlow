import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __geminiOAuthTest, resolveGeminiOAuthClientConfigAsync } from "./oauthClient";

let tempRoot: string;
beforeEach(async () => { tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexflow-gemini-oauth-")); });
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(tempRoot, { recursive: true, force: true }); });

describe("Gemini 安装包 OAuth 配置", () => {
  it("按真实安装版本生成标识，保留 CodexFlow 查询用途且不执行 CLI", async () => {
    const root = path.join(tempRoot, "node_modules", "@google", "gemini-cli");
    await fs.mkdir(root, { recursive: true });
    const entry = path.join(root, "cli.js");
    await fs.writeFile(path.join(root, "package.json"), "\uFEFF" + JSON.stringify({ name: "@google/gemini-cli", version: "1.2.3-test.4" }), "utf8");
    await fs.writeFile(entry, "throw new Error('不得执行 CLI');", "utf8");
    const installed = __geminiOAuthTest.readInstalledGeminiClient([entry], true);
    expect(installed).toEqual({ version: "1.2.3-test.4", oauth: null });
    expect(__geminiOAuthTest.formatGeminiUsageUserAgent(installed!.version))
      .toBe(`GeminiCLI/1.2.3-test.4/usage (${process.platform}; ${process.arch}; terminal) CodexFlow (usage-query)`);
  });

  it("安装包没有版本时只声明 CodexFlow 身份，不编造官方版本", async () => {
    const root = path.join(tempRoot, "node_modules", "@google", "gemini-cli");
    await fs.mkdir(root, { recursive: true });
    const entry = path.join(root, "cli.js");
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@google/gemini-cli" }), "utf8");
    await fs.writeFile(entry, "", "utf8");
    const installed = __geminiOAuthTest.readInstalledGeminiClient([entry], true);
    expect(installed).toBeNull();
    const userAgent = __geminiOAuthTest.formatGeminiUsageUserAgent(installed?.version ?? null);
    expect(userAgent).toContain("CodexFlow (usage-query)");
    expect(userAgent).not.toContain("GeminiCLI/");
  });

  it("读取新版拆分包，只解析常量且不执行模块", async () => {
    const root = path.join(tempRoot, "node_modules", "@google", "gemini-cli");
    await fs.mkdir(path.join(root, "bundle"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@google/gemini-cli" }), "utf8");
    const entry = path.join(root, "bundle", "gemini.js");
    await fs.writeFile(entry, "throw new Error('不得执行安装包');", "utf8");
    await fs.writeFile(path.join(root, "bundle", "chunk-test.js"),
      'const OAUTH_CLIENT_ID = "test-client"; const OAUTH_CLIENT_SECRET = "test-secret";', "utf8");
    expect(__geminiOAuthTest.readInstalledOAuthClient([entry])).toEqual({ clientId: "test-client", clientSecret: "test-secret" });
  });

  it("优先使用用户明确提供的客户端配置", async () => {
    vi.stubEnv("CODEXFLOW_GEMINI_OAUTH_CLIENT_ID", "test-client");
    vi.stubEnv("CODEXFLOW_GEMINI_OAUTH_CLIENT_SECRET", "test-secret");
    expect(await resolveGeminiOAuthClientConfigAsync({ terminal: "wsl", distro: "TestLinux" }))
      .toEqual({ clientId: "test-client", clientSecret: "test-secret" });
  });
});
