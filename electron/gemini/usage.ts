// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { perfLogger } from "../log";

export type GeminiQuotaBucket = {
  remainingAmount?: string;
  remainingFraction?: number;
  resetTime?: string;
  tokenType?: string;
  modelId?: string;
};

export type GeminiQuotaSnapshot = {
  providerId: "gemini";
  collectedAt: number;
  projectId?: string | null;
  tierId?: string | null;
  buckets: GeminiQuotaBucket[];
};

type ProviderRuntimeEnv = { terminal: "wsl" | "windows" | "pwsh"; distro?: string };

type GeminiOauthCredsFile = {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
};

type LoadCodeAssistResponse = {
  currentTier?: { id?: string };
  cloudaicompanionProject?: string;
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
};

type LongRunningOperationResponse = {
  name?: string;
  done?: boolean;
  response?: { cloudaicompanionProject?: { id?: string } };
};

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_API_VERSION = "v1internal";

type GeminiOAuthClientConfig = {
  clientId: string;
  clientSecret: string;
};

/**
 * 解析 Gemini OAuth 客户端配置（用于用 refresh_token 刷新 access_token）。
 *
 * 注意：由于仓库安全策略（GitHub Push Protection），项目源码中不允许硬编码任何 OAuth Client ID/Secret；
 * 若希望启用自动刷新，请自行创建 OAuth 客户端，并通过环境变量注入：
 * - CODEXFLOW_GEMINI_OAUTH_CLIENT_ID
 * - CODEXFLOW_GEMINI_OAUTH_CLIENT_SECRET
 */
function resolveGeminiOAuthClientConfigFromEnv(): GeminiOAuthClientConfig | null {
  const clientId = String(process.env.CODEXFLOW_GEMINI_OAUTH_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.CODEXFLOW_GEMINI_OAUTH_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * 解析 Code Assist 的 baseUrl（允许通过环境变量覆盖 endpoint）。
 */
function getCodeAssistBaseUrl(): string {
  const endpoint = String(process.env.CODE_ASSIST_ENDPOINT || CODE_ASSIST_ENDPOINT).trim() || CODE_ASSIST_ENDPOINT;
  return `${endpoint}/${CODE_ASSIST_API_VERSION}`;
}

/**
 * 生成 Code Assist 的 method URL（POST `baseUrl:methodName`）。
 */
function methodUrl(method: string): string {
  return `${getCodeAssistBaseUrl()}:${method}`;
}

/**
 * 生成 Code Assist 的 operation URL（GET `baseUrl/<opName>`）。
 */
function operationUrl(name: string): string {
  return `${getCodeAssistBaseUrl()}/${name}`;
}

/**
 * 带超时的 fetch JSON，避免网络请求无限等待。
 */
async function fetchJsonWithTimeoutAsync(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; data: any; raw: string }> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const raw = await res.text().catch(() => "");
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data, raw };
  } finally {
    clearTimeout(id);
  }
}

/**
 * 使用 refresh_token 刷新 access_token。
 */
async function refreshAccessTokenAsync(
  refreshToken: string,
  oauth: GeminiOAuthClientConfig,
  timeoutMs: number,
): Promise<{ accessToken: string; expiryDateMs: number }> {
  const body = new URLSearchParams();
  body.set("client_id", oauth.clientId);
  body.set("client_secret", oauth.clientSecret);
  body.set("refresh_token", refreshToken);
  body.set("grant_type", "refresh_token");

  const res = await fetchJsonWithTimeoutAsync(
    GOOGLE_OAUTH_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    timeoutMs,
  );
  if (!res.ok) {
    const msg = String(res.data?.error_description || res.data?.error || res.raw || `HTTP ${res.status}`).trim();
    throw new Error(`Gemini token 刷新失败：${msg}`);
  }

  const accessToken = String(res.data?.access_token || "").trim();
  const expiresIn = Number(res.data?.expires_in ?? 0);
  if (!accessToken) throw new Error("Gemini token 刷新失败：未返回 access_token");
  const expiryDateMs = Date.now() + Math.max(60, expiresIn) * 1000;
  return { accessToken, expiryDateMs };
}

/**
 * 解析 Windows 侧 Gemini CLI 的主目录（默认为 `%USERPROFILE%\\.gemini`）。
 */
function resolveGeminiHomeWindows(): string {
  const base = String(process.env.GEMINI_HOME || "").trim();
  return base || path.join(os.homedir(), ".gemini");
}

/**
 * 将 Windows 绝对路径转换为 WSL `/mnt/<drive>/...` 形式（仅用于提示文案）。
 */
function tryConvertWindowsPathToWslMountPathForHint(winPath: string): string | null {
  const raw = String(winPath || "").trim();
  if (!raw) return null;
  let p = raw;
  if (p.startsWith("\\\\?\\")) p = p.slice(4);
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return null;
  const drive = String(m[1] || "").toLowerCase();
  const rest = String(m[2] || "").replace(/\\/g, "/");
  if (!drive || !rest) return null;
  return `/mnt/${drive}/${rest}`;
}

/**
 * 读取 Windows 侧 `oauth_creds.json`。
 */
async function readGeminiOauthCredsWindowsAsync(): Promise<GeminiOauthCredsFile | null> {
  try {
    const home = resolveGeminiHomeWindows();
    const p = path.join(home, "oauth_creds.json");
    const raw = await fs.readFile(p, "utf8");
    const obj = JSON.parse(String(raw || "")) as GeminiOauthCredsFile;
    if (!obj || typeof obj !== "object") return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * 在 Windows 下执行 wsl.exe 并读取 stdout（带超时）。
 */
function execWslTextAsync(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "wsl.exe",
      args,
      { windowsHide: true, timeout: Math.max(1000, timeoutMs), maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout ?? ""));
      },
    );
  });
}

/**
 * 读取 WSL 侧 `~/.gemini/oauth_creds.json`。
 */
async function readGeminiOauthCredsWslAsync(distro?: string): Promise<GeminiOauthCredsFile | null> {
  if (os.platform() !== "win32") return null;
  const cmd = "cat ~/.gemini/oauth_creds.json 2>/dev/null || true";
  const args = distro ? ["-d", distro, "--", "sh", "-lc", cmd] : ["--", "sh", "-lc", cmd];
  try {
    const raw = await execWslTextAsync(args, 5000);
    const text = String(raw || "").trim();
    if (!text) return null;
    const obj = JSON.parse(text) as GeminiOauthCredsFile;
    if (!obj || typeof obj !== "object") return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * 按 Provider 运行环境解析 Gemini 的 OAuth 凭据（不做跨环境回退）。
 */
async function resolveGeminiOauthCredsAsync(env: ProviderRuntimeEnv): Promise<GeminiOauthCredsFile | null> {
  // 说明：不做跨环境回退，严格按当前 Provider 运行环境读取对应路径。
  // - terminal=wsl：读取 WSL 内 `~/.gemini/oauth_creds.json`
  // - terminal=windows/pwsh：读取 Windows 内 `%USERPROFILE%\\.gemini\\oauth_creds.json`
  if (env.terminal === "wsl") return readGeminiOauthCredsWslAsync(env.distro);
  return readGeminiOauthCredsWindowsAsync();
}

/**
 * 判断文件是否存在。
 */
async function fileExistsAsync(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取可用 access_token：若本地 access_token 即将过期，则尝试用 refresh_token 刷新。
 */
async function resolveValidAccessTokenAsync(creds: GeminiOauthCredsFile): Promise<{ accessToken: string; expiryDateMs: number }> {
  const access = String(creds.access_token || "").trim();
  const refresh = String(creds.refresh_token || "").trim();
  const expiry = Number(creds.expiry_date ?? 0);
  const now = Date.now();
  const safeWindowMs = 90_000;

  if (access && Number.isFinite(expiry) && expiry > now + safeWindowMs) {
    return { accessToken: access, expiryDateMs: expiry };
  }
  if (!refresh) {
    throw new Error("Gemini 未提供 refresh_token，请先在终端重新登录（gemini → Login with Google）");
  }

  const oauth = resolveGeminiOAuthClientConfigFromEnv();
  if (!oauth) {
    throw new Error(
      "Gemini access_token 已过期，且未配置 OAuth 客户端用于自动刷新（需要 client_id/client_secret）。" +
      "请在对应运行环境运行 `gemini` 并重新登录以更新 oauth_creds.json，或设置环境变量 " +
      "CODEXFLOW_GEMINI_OAUTH_CLIENT_ID / CODEXFLOW_GEMINI_OAUTH_CLIENT_SECRET 后重试。"
    );
  }
  return refreshAccessTokenAsync(refresh, oauth, 10_000);
}

/**
 * 调用 Code Assist POST 接口。
 */
async function codeAssistPostAsync<T extends object>(
  method: string,
  body: T,
  accessToken: string,
  timeoutMs: number,
): Promise<any> {
  const res = await fetchJsonWithTimeoutAsync(
    methodUrl(method),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
  if (res.ok) return res.data;
  const message =
    String(res.data?.error?.message || res.data?.error || res.raw || "").trim() || `HTTP ${res.status}`;
  throw new Error(`Gemini ${method} 请求失败：${message}`);
}

/**
 * 调用 Code Assist GET 接口（用于轮询 long-running operation）。
 */
async function codeAssistGetAsync(
  url: string,
  accessToken: string,
  timeoutMs: number,
): Promise<any> {
  const res = await fetchJsonWithTimeoutAsync(
    url,
    {
      method: "GET",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
    },
    timeoutMs,
  );
  if (res.ok) return res.data;
  const message =
    String(res.data?.error?.message || res.data?.error || res.raw || "").trim() || `HTTP ${res.status}`;
  throw new Error(`Gemini 操作请求失败：${message}`);
}

/**
 * 从环境变量推断 Google Cloud 项目提示（可选）。
 */
function resolveProjectHintFromEnv(): string | undefined {
  const v = String(process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || "").trim();
  return v || undefined;
}

/**
 * 组装 Code Assist 的 client metadata（尽量保持最小字段以避免后端兼容性问题）。
 */
function coreClientMetadata(projectId?: string): any {
  return {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
    ...(projectId ? { duetProject: projectId } : {}),
  };
}

/**
 * 从 loadCodeAssist 响应中解析默认 tierId（优先 isDefault）。
 */
function getDefaultTierId(loadRes: LoadCodeAssistResponse): string | null {
  const tiers = Array.isArray(loadRes.allowedTiers) ? loadRes.allowedTiers : [];
  const def = tiers.find((t) => t && t.isDefault && t.id);
  if (def?.id) return String(def.id);
  const first = tiers.find((t) => t && t.id);
  if (first?.id) return String(first.id);
  return null;
}

/**
 * 确保用户已完成 Code Assist onboarding，并返回 projectId/tierId。
 */
async function setupUserProjectAsync(accessToken: string): Promise<{ projectId: string; tierId: string | null }> {
  const projectHint = resolveProjectHintFromEnv();
  const loadBody = {
    cloudaicompanionProject: projectHint,
    metadata: coreClientMetadata(projectHint),
  };
  const loadRes = (await codeAssistPostAsync("loadCodeAssist", loadBody, accessToken, 12_000)) as LoadCodeAssistResponse;

  const currentTierId = loadRes?.currentTier?.id ? String(loadRes.currentTier.id) : null;
  const projectFromServer = loadRes?.cloudaicompanionProject ? String(loadRes.cloudaicompanionProject) : null;
  if (currentTierId) {
    if (!projectFromServer) {
      if (projectHint) return { projectId: projectHint, tierId: currentTierId };
      throw new Error("该账号需要设置 GOOGLE_CLOUD_PROJECT（或 GOOGLE_CLOUD_PROJECT_ID）后才能获取用量");
    }
    return { projectId: projectFromServer, tierId: currentTierId };
  }

  // 未完成 onboarding：选择默认 tier 触发一次 onboard，随后轮询 operation
  const tierId = getDefaultTierId(loadRes);
  if (!tierId) throw new Error("无法确定 Gemini Code Assist Tier");

  const onboardBody: any = {
    tierId,
    metadata: coreClientMetadata(projectHint),
  };
  if (tierId !== "FREE") {
    onboardBody.cloudaicompanionProject = projectHint;
    onboardBody.metadata = coreClientMetadata(projectHint);
  } else {
    onboardBody.cloudaicompanionProject = undefined;
    onboardBody.metadata = coreClientMetadata(undefined);
  }

  let op = (await codeAssistPostAsync("onboardUser", onboardBody, accessToken, 20_000)) as LongRunningOperationResponse;
  const start = Date.now();
  const maxWaitMs = 60_000;
  while (!op?.done && op?.name && Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 5000));
    op = (await codeAssistGetAsync(operationUrl(op.name), accessToken, 12_000)) as LongRunningOperationResponse;
  }

  const fromOp = op?.response?.cloudaicompanionProject?.id ? String(op.response.cloudaicompanionProject.id) : null;
  if (fromOp) return { projectId: fromOp, tierId };
  if (projectHint) return { projectId: projectHint, tierId };
  throw new Error("Gemini onboarding 未返回 projectId，且未提供 GOOGLE_CLOUD_PROJECT");
}

/**
 * 获取 Gemini CLI（Code Assist）用量快照：从本地 oauth_creds.json 刷新 token 后调用 Code Assist retrieveUserQuota。
 */
export async function getGeminiQuotaSnapshotAsync(env: ProviderRuntimeEnv): Promise<GeminiQuotaSnapshot> {
  return perfLogger.time("[gemini] quota snapshot", async () => {
    const creds = await resolveGeminiOauthCredsAsync(env);
    if (!creds) {
      const winPath = path.join(resolveGeminiHomeWindows(), "oauth_creds.json");
      const winExists = await fileExistsAsync(winPath);
      const winWslPath = tryConvertWindowsPathToWslMountPathForHint(winPath);
      const wslHint = `~/.gemini/oauth_creds.json（WSL：${env.distro || "default"}）`;
      if (env.terminal === "wsl") {
        throw new Error(
          `未找到 Gemini 登录凭据（oauth_creds.json）。当前 Gemini 运行环境为 WSL，因此只会读取：${wslHint}。` +
          (winExists
            ? `（检测到 Windows 侧存在：${winPath}，但当前配置不会读取。请在设置里把 Gemini 环境切换为 Windows/Pwsh，或将该文件复制到 WSL 的 ~/.gemini/oauth_creds.json` +
              (winWslPath ? `，例如执行：mkdir -p ~/.gemini && cp \"${winWslPath}\" ~/.gemini/oauth_creds.json` : "") +
              `）`
            : `（Windows 侧也未检测到：${winPath}）`)
        );
      }
      throw new Error(`未找到 Gemini 登录凭据（oauth_creds.json）。当前 Gemini 运行环境为 Windows，因此只会读取：${winPath}。请先运行 \`gemini\` 并完成登录。`);
    }

    const { accessToken } = await resolveValidAccessTokenAsync(creds);
    const { projectId, tierId } = await setupUserProjectAsync(accessToken);
    // 兼容：部分后端不接受 userAgent 字段（会报 Unknown name "userAgent"），因此仅传 project。
    const quota = await codeAssistPostAsync("retrieveUserQuota", { project: projectId }, accessToken, 12_000);
    const buckets = Array.isArray(quota?.buckets) ? (quota.buckets as GeminiQuotaBucket[]) : [];
    return {
      providerId: "gemini",
      collectedAt: Date.now(),
      projectId: projectId || null,
      tierId,
      buckets,
    };
  });
}
