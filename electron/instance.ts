// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { getFeatureFlags } from "./featureFlags";

export type InstanceProfile = {
  /** Profile 标识（用于隔离 userData；默认 default） */
  profileId: string;
  /** 当前实例使用的 userData 目录 */
  userDataDir: string;
  /** Profile 来源：命令行 / 协议激活 / 环境变量 / 默认 */
  source: "argv" | "protocol" | "env" | "default";
};

const DEFAULT_PROFILE_ID = "default";
let cachedProfile: InstanceProfile | null = null;

/**
 * 基于“基础 userData 目录 + profileId”计算当前 profile 的 userData 目录。
 * 说明：baseUserDataDir 应为未追加 profile 后缀的目录，否则可能产生嵌套后缀（例如 `*-profile-a-profile-b`）。
 */
export function resolveProfileUserDataDir(baseUserDataDir: string, rawProfileId: string): string {
  const profileId = normalizeProfileId(rawProfileId);
  return resolveUserDataDir(baseUserDataDir, profileId);
}

/**
 * 归一化并清洗 profileId，避免生成非法路径或极端长度导致异常。
 */
export function normalizeProfileId(raw: unknown): string {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input) return DEFAULT_PROFILE_ID;
  const lowered = input.toLowerCase();
  if (lowered === DEFAULT_PROFILE_ID) return DEFAULT_PROFILE_ID;
  const safe = lowered
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  const limited = safe.slice(0, 48);
  return limited || DEFAULT_PROFILE_ID;
}

/**
 * 从命令行参数中解析 profile（支持：--profile <id> / --profile=<id>）。
 */
function parseProfileFromArgv(argv: readonly string[]): string | null {
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--profile") {
        const next = argv[i + 1];
        if (typeof next === "string" && next.trim()) return next.trim();
      }
      if (typeof arg === "string" && arg.startsWith("--profile=")) {
        const val = arg.slice("--profile=".length);
        if (val.trim()) return val.trim();
      }
    }
  } catch {}
  return null;
}

/**
 * 从协议激活 URL 中解析 profile（支持：...?profile=<id> 或 ...?p=<id>）。
 * 用途：Windows 通知 Action Center 点击会以协议启动应用；多实例时需要路由到正确 profile。
 */
function parseProfileFromProtocolArgv(argv: readonly string[]): string | null {
  try {
    for (const arg of argv) {
      if (typeof arg !== "string") continue;
      if (!arg.includes("://")) continue;
      try {
        const u = new URL(arg);
        const p = u.searchParams.get("profile") || u.searchParams.get("p");
        if (p && p.trim()) return p.trim();
      } catch {}
    }
  } catch {}
  return null;
}

/**
 * 根据 profileId 计算隔离后的 userData 目录。
 */
function resolveUserDataDir(defaultUserDataDir: string, profileId: string): string {
  if (!profileId || profileId === DEFAULT_PROFILE_ID) return defaultUserDataDir;
  try {
    const baseDir = path.dirname(defaultUserDataDir);
    const baseName = path.basename(defaultUserDataDir);
    return path.join(baseDir, `${baseName}-profile-${profileId}`);
  } catch {
    return defaultUserDataDir;
  }
}

/**
 * 从 JSON 文件中读取对象（读取/解析失败则返回 null）。
 */
function readJsonObjectSafe(filePath: string): Record<string, any> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as any;
  } catch {
    return null;
  }
}

/**
 * 初始化新 profile 的基础数据（仅在目标文件缺失时复制，避免覆盖用户已有内容）。
 * 目的：让自动/首次创建的 profile 能复用默认设置与项目列表，减少二次配置成本。
 */
function bootstrapProfileUserData(baseUserDataDir: string, profileUserDataDir: string): void {
  if (!baseUserDataDir || !profileUserDataDir) return;
  if (baseUserDataDir === profileUserDataDir) return;
  try { fs.mkdirSync(profileUserDataDir, { recursive: true }); } catch {}

  // settings.json：复制并剥离 experimental（该字段由主进程全局维护）
  try {
    const from = path.join(baseUserDataDir, "settings.json");
    const to = path.join(profileUserDataDir, "settings.json");
    if (!fs.existsSync(to)) {
      const obj = readJsonObjectSafe(from);
      if (obj) {
        try { if (Object.prototype.hasOwnProperty.call(obj, "experimental")) delete (obj as any).experimental; } catch {}
        try { fs.writeFileSync(to, JSON.stringify(obj, null, 2), "utf8"); } catch {}
      }
    }
  } catch {}

  // projects.json：复制项目列表（新 profile 仍是独立副本，后续互不影响）
  try {
    const from = path.join(baseUserDataDir, "projects.json");
    const to = path.join(profileUserDataDir, "projects.json");
    if (!fs.existsSync(to)) {
      const obj = readJsonObjectSafe(from);
      if (obj) {
        try { fs.writeFileSync(to, JSON.stringify(obj, null, 2), "utf8"); } catch {}
      }
    }
  } catch {}

  // debug.config.jsonc：直接复制（JSONC 含注释，避免解析）
  try {
    const from = path.join(baseUserDataDir, "debug.config.jsonc");
    const to = path.join(profileUserDataDir, "debug.config.jsonc");
    if (!fs.existsSync(to) && fs.existsSync(from)) {
      const raw = fs.readFileSync(from, "utf8");
      if (raw != null) fs.writeFileSync(to, String(raw), "utf8");
    }
  } catch {}
}

/**
 * 在主进程启动早期应用 profile：
 * - 必须在 `app.requestSingleInstanceLock()` 之前调用，才能做到“按 profile 隔离单例锁 + Chromium Profile 锁”；
 * - 若未指定 profile，则保持原 userData 不变，兼容现有用户数据目录。
 */
export function applyInstanceProfile(): InstanceProfile {
  if (cachedProfile) return cachedProfile;

  const initialUserDataDir = (() => {
    try { return app.getPath("userData"); } catch { return process.cwd(); }
  })();
  const baseUserDataDir = (() => {
    try {
      const fromEnv = String(process.env.CODEXFLOW_BASE_USERDATA || "").trim();
      if (fromEnv) return fromEnv;
    } catch {}
    return initialUserDataDir;
  })();

  // 记录基础 userData（跨 profile 共享，用于全局 feature flags 等）；若已存在则不覆盖
  try {
    const cur = String(process.env.CODEXFLOW_BASE_USERDATA || "").trim();
    if (!cur) process.env.CODEXFLOW_BASE_USERDATA = baseUserDataDir;
  } catch {}

  const flags = getFeatureFlags();
  const multiInstanceEnabled = !!flags.multiInstanceEnabled;

  const argvProfile = parseProfileFromArgv(process.argv);
  const protocolProfile = parseProfileFromProtocolArgv(process.argv);
  const envProfile = typeof process.env.CODEXFLOW_PROFILE === "string" ? process.env.CODEXFLOW_PROFILE : null;

  const requested = argvProfile ?? protocolProfile ?? envProfile ?? DEFAULT_PROFILE_ID;
  const chosen = multiInstanceEnabled ? requested : DEFAULT_PROFILE_ID;
  const source: InstanceProfile["source"] = (() => {
    if (!multiInstanceEnabled) return "default";
    return argvProfile ? "argv" : protocolProfile ? "protocol" : envProfile ? "env" : "default";
  })();

  const profileId = normalizeProfileId(chosen);
  const nextUserDataDir = multiInstanceEnabled ? resolveUserDataDir(baseUserDataDir, profileId) : initialUserDataDir;

  // 强制对齐 Chromium 的 user-data-dir：避免少数环境下 `setPath("userData")` 未能影响单例锁/Chromium Profile 锁
  if (multiInstanceEnabled) {
    try { app.commandLine.appendSwitch("user-data-dir", nextUserDataDir); } catch {}
  }

  // 为首次创建的 profile 复制默认设置/项目列表，避免用户每次多开都要重新配置
  if (multiInstanceEnabled && nextUserDataDir !== baseUserDataDir) {
    try { bootstrapProfileUserData(baseUserDataDir, nextUserDataDir); } catch {}
  }
  // 将 Electron 侧 userData 对齐到目标 profile（可能已由 `--user-data-dir` 在启动阶段设置好）
  if (multiInstanceEnabled && nextUserDataDir !== initialUserDataDir) {
    try { app.setPath("userData", nextUserDataDir); } catch {}
  }

  // 统一写回环境变量，便于其它模块复用（如通知协议 URL 拼装）
  try { process.env.CODEXFLOW_PROFILE = profileId; } catch {}

  cachedProfile = {
    profileId,
    userDataDir: (() => {
      try { return app.getPath("userData"); } catch { return nextUserDataDir; }
    })(),
    source,
  };
  return cachedProfile;
}

/**
 * 获取当前已应用的 profileId（若尚未应用则返回 default）。
 */
export function getActiveProfileId(): string {
  try {
    return cachedProfile?.profileId || normalizeProfileId(process.env.CODEXFLOW_PROFILE) || DEFAULT_PROFILE_ID;
  } catch {
    return DEFAULT_PROFILE_ID;
  }
}
