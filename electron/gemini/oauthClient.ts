// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

type OAuthClientConfig = { clientId: string; clientSecret: string };
type RuntimeEnv = { terminal: "wsl" | "windows" | "pwsh" | "cmd"; distro?: string };
type InstalledGeminiClient = { oauth: OAuthClientConfig | null; version: string | null };

/** 只读查找官方安装包的版本与 OAuth 配置，不导入或执行 CLI 代码。 */
function readInstalledGeminiClient(entries: string[], metadataOnly = false): InstalledGeminiClient | null {
  // 此方法会在 WSL 的 Node 中执行，所有依赖必须在方法内部声明。
  const localFs: typeof fs = require("node:fs");
  const localPath: typeof path = require("node:path");
  const roots = new Set<string>();
  for (const entry of entries) {
    if (!entry) continue;
    try {
      let dir = localPath.dirname(localFs.realpathSync(entry));
      roots.add(localPath.join(dir, "node_modules", "@google", "gemini-cli"));
      for (let level = 0; level < 5; level += 1) {
        const manifest = localPath.join(dir, "package.json");
        if (localFs.existsSync(manifest) && JSON.parse(localFs.readFileSync(manifest, "utf8").replace(/^\uFEFF/, "")).name === "@google/gemini-cli") {
          roots.add(dir);
          break;
        }
        dir = localPath.dirname(dir);
      }
    } catch {}
  }
  let knownVersion: string | null = null;
  for (const root of roots) {
    let version: string | null = null;
    try {
      const manifest = JSON.parse(localFs.readFileSync(localPath.join(root, "package.json"), "utf8").replace(/^\uFEFF/, ""));
      if (manifest.name === "@google/gemini-cli" && typeof manifest.version === "string" && /^[0-9A-Za-z.+_-]+$/.test(manifest.version)) {
        version = manifest.version;
        knownVersion ??= version;
        if (metadataOnly) return { oauth: null, version };
      }
    } catch {}
    if (metadataOnly) continue;
    const files = [
      localPath.join(root, "node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js"),
      localPath.join(root, "../gemini-cli-core/dist/src/code_assist/oauth2.js"),
      localPath.join(root, "bundle/gemini.js"),
    ];
    try {
      // 新版发行包拆成多个块，认证常量所在块不一定超过 1 MB。
      files.push(...localFs.readdirSync(localPath.join(root, "bundle"))
        .filter((name) => /^chunk-.*\.js$/.test(name))
        .map((name) => localPath.join(root, "bundle", name)));
    } catch {}
    for (const file of files) {
      try {
        const source = localFs.readFileSync(file, "utf8");
        const clientId = /\bOAUTH_CLIENT_ID\s*=\s*["']([^"']+)["']/.exec(source)?.[1];
        const clientSecret = /\bOAUTH_CLIENT_SECRET\s*=\s*["']([^"']+)["']/.exec(source)?.[1];
        if (clientId && clientSecret) return { oauth: { clientId, clientSecret }, version };
      } catch {}
    }
  }
  return knownVersion ? { oauth: null, version: knownVersion } : null;
}

/** 在当前环境只读定位官方安装包，WSL 无 Node 时允许读取 Windows 的公共安装信息。 */
async function resolveInstalledGeminiClientAsync(env: RuntimeEnv, metadataOnly = false): Promise<InstalledGeminiClient | null> {
  if (env.terminal === "wsl") {
    const args = [...(env.distro ? ["-d", env.distro] : []), "--", "sh", "-lc",
      'GEMINI_CLI_PATH="$(command -v gemini 2>/dev/null)" node'];
    const script = `const probe = ${readInstalledGeminiClient.toString()}; process.stdout.write(JSON.stringify(probe([process.env.GEMINI_CLI_PATH || ""], ${metadataOnly})));`;
    const configured = await new Promise<InstalledGeminiClient | null>((resolve) => {
      const child = execFile("wsl.exe", args, { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve(null);
        try { resolve(JSON.parse(String(stdout).replace(/^\uFEFF/, ""))); }
        catch { resolve(null); }
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(script);
    });
    if (configured && (metadataOnly || configured.oauth)) return configured;
    // WSL 未安装 Node 时可复用 Windows 官方 CLI 的公共客户端配置；凭据仍只从 WSL 读取。
  }
  const entries = await new Promise<string[]>((resolve) => {
    execFile(process.platform === "win32" ? "where.exe" : "which", ["gemini"],
      { windowsHide: true, timeout: 5000 }, (_error, stdout) => resolve(String(stdout || "").trim().split(/\r?\n/)));
  });
  return readInstalledGeminiClient(entries, metadataOnly);
}

/** 优先读取用户提供的客户端配置，否则使用官方安装包中的公共 OAuth 配置。 */
export async function resolveGeminiOAuthClientConfigAsync(env: RuntimeEnv): Promise<OAuthClientConfig | null> {
  const clientId = String(process.env.CODEXFLOW_GEMINI_OAUTH_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.CODEXFLOW_GEMINI_OAUTH_CLIENT_SECRET || "").trim();
  if (clientId && clientSecret) return { clientId, clientSecret };
  return (await resolveInstalledGeminiClientAsync(env))?.oauth ?? null;
}

/** 只使用已安装的真实版本，并保留 CodexFlow 与额度查询用途。 */
function formatGeminiUsageUserAgent(version: string | null): string {
  const identity = "CodexFlow (usage-query)";
  if (!version) return `${identity} (${process.platform}; ${process.arch})`;
  return `GeminiCLI/${version}/usage (${process.platform}; ${process.arch}; terminal) ${identity}`;
}

/** 获取额度查询客户端标识，有效访问令牌同样需要该标识。 */
export async function resolveGeminiUsageUserAgentAsync(env: RuntimeEnv): Promise<string> {
  const installation = await resolveInstalledGeminiClientAsync(env, true);
  return formatGeminiUsageUserAgent(installation?.version ?? null);
}

/** 保留仅返回 OAuth 配置的测试入口。 */
function readInstalledOAuthClient(entries: string[]): OAuthClientConfig | null {
  return readInstalledGeminiClient(entries)?.oauth ?? null;
}

export const __geminiOAuthTest = { readInstalledOAuthClient, readInstalledGeminiClient, formatGeminiUsageUserAgent };
