// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { app } from "electron";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexAccountInfo } from "./bridge";
export { resolveCodexAuthJsonPathAsync } from "./authPath";

export type CodexAccountStatusKey = "signed_in" | "signed_out";

export type CodexAuthBackupItem = {
  id: string;
  createdAt: number;
  updatedAt: number;
  runtimeKey: string;
  signature: string;
  status: CodexAccountStatusKey;
  accountId: string | null;
  userId: string | null;
  email: string | null;
  plan: string | null;
  reason: string;
};

type CodexAuthBackupMeta = CodexAuthBackupItem & {
  version: 1;
};

/**
 * 生成一个稳定的“账号状态”键：仅用于识别与比对，不参与 UI 文案。
 */
export function resolveCodexAccountStatusKey(info: CodexAccountInfo | null | undefined): CodexAccountStatusKey {
  const accountId = String(info?.accountId || "").trim();
  const userId = String(info?.userId || "").trim();
  const email = String(info?.email || "").trim();
  return (accountId || userId || email) ? "signed_in" : "signed_out";
}

/**
 * 生成“账号身份签名”：用于识别账号变化与备份去重。
 * 说明：
 * - 旧版本仅使用 accountId，部分环境下可能无法区分不同账号；
 * - 同时保留用户与工作区身份，避免同一用户在多个工作区的备份互相覆盖。
 */
export function resolveCodexAccountSignature(info: CodexAccountInfo | null | undefined): {
  status: CodexAccountStatusKey;
  accountId: string | null;
  signature: string;
} {
  const status = resolveCodexAccountStatusKey(info);
  const accountId = status === "signed_in" ? String(info?.accountId || "").trim() || null : null;
  const userId = status === "signed_in" ? String(info?.userId || "").trim() || null : null;
  const email = status === "signed_in" ? String(info?.email || "").trim().toLowerCase() || null : null;
  const identity = [userId || email || "", accountId || ""].join("|");
  const signature = `v3|${status}|${identity}`;
  return { status, accountId, signature };
}

/**
 * 校验备份 ID：避免渲染层注入任意路径读写。
 */
export function isSafeAuthBackupId(id: string): boolean {
  const s = String(id || "").trim().toLowerCase();
  return /^[a-f0-9]{12,64}$/.test(s);
}

/**
 * 获取 CodexFlow 用户数据目录（失败则回退到 ~/.codexflow）。
 */
function getUserDataDir(): string {
  try {
    const p = app.getPath("userData");
    return p || path.join(os.homedir(), ".codexflow");
  } catch {
    return path.join(os.homedir(), ".codexflow");
  }
}

/**
 * 获取 auth.json 备份根目录（全局共享，不随运行环境隔离）。
 */
function getBackupDir(_runtimeKey: string): string {
  return path.join(getUserDataDir(), "codex-auth-backups");
}

/**
 * 将签名映射为备份文件 ID（稳定且尽量短）。
 */
function backupIdFromSignature(signature: string): string {
  return createHash("sha256").update(String(signature || ""), "utf8").digest("hex").slice(0, 16);
}

/** 校验文件中的实际身份，避免外部切换后将新凭据写入旧账号的备份。 */
function assertAuthContentMatchesAccount(content: Buffer, expected: {
  accountId: string | null;
  userId?: string | null;
  email?: string | null;
}): void {
  const raw = JSON.parse(content.toString("utf8").replace(/^\uFEFF/, ""));
  if (!raw || typeof raw !== "object" || !raw.tokens
    || (raw.auth_mode && !["chatgpt", "chatgptAuthTokens"].includes(raw.auth_mode))
    || (!raw.auth_mode && raw.OPENAI_API_KEY))
    throw new Error("认证文件不是可备份的 ChatGPT 登录凭据");

  const claims: any[] = [];
  for (const token of [raw.tokens.access_token, raw.tokens.id_token]) {
    if (typeof token !== "string") continue;
    try {
      const parts = token.split(".");
      if (parts.length === 3)
        claims.push(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
    } catch {}
  }
  const authClaims = claims.map((claim) => claim?.["https://api.openai.com/auth"] ?? {});
  const actual = {
    accountId: raw.tokens.account_id || authClaims.find((claim) => claim.chatgpt_account_id)?.chatgpt_account_id || null,
    userId: authClaims.map((claim) => claim.chatgpt_user_id || claim.user_id).find(Boolean) || null,
    email: claims.map((claim) => claim?.email || claim?.["https://api.openai.com/profile"]?.email).find(Boolean) || null,
  };
  let matched = false;
  for (const key of ["accountId", "userId", "email"] as const) {
    const requested = String(expected[key] || "").trim();
    if (!requested) continue;
    const found = String(actual[key] || "").trim();
    // 身份 ID 可严格比对；令牌未携带邮箱时以身份 ID 为准。
    if (key === "email" && !found && matched) continue;
    if ((key === "email" ? found.toLowerCase() : found) !== (key === "email" ? requested.toLowerCase() : requested))
      throw new Error("认证文件的账号已变化，未写入备份或覆盖当前凭据，请刷新后重试");
    matched = true;
  }
  if (!matched || typeof raw.tokens.access_token !== "string" || !raw.tokens.access_token.trim())
    throw new Error("无法确认认证文件的账号身份，未写入备份或覆盖当前凭据");
}

/**
 * 仅更新指定签名的备份 meta（不重写 auth 文件），用于补齐套餐/邮箱等字段。
 * - 若 auth 备份不存在则返回错误（调用方可降级为 full upsert）。
 */
export async function upsertCodexAuthBackupMetaOnlyAsync(args: {
  runtimeKey: string;
  signature: string;
  status: CodexAccountStatusKey;
  accountId: string | null;
  userId?: string | null;
  email?: string | null;
  plan?: string | null;
  reason?: string;
  /** 是否更新时间戳（默认 false，避免仅补齐字段就影响排序） */
  touchUpdatedAt?: boolean;
}): Promise<{ ok: true; item: CodexAuthBackupItem } | { ok: false; error: string }> {
  try {
    const runtimeKey = String(args.runtimeKey || "").trim();
    if (!runtimeKey) return { ok: false, error: "missing runtimeKey" };
    const signature = String(args.signature || "").trim();
    if (!signature) return { ok: false, error: "missing signature" };

    const id = backupIdFromSignature(signature);
    const { authPath, metaPath } = resolveBackupPaths(runtimeKey, id);
    if (!fs.existsSync(authPath)) return { ok: false, error: "backup auth not found" };

    const prev = normalizeMeta(await readJsonSafe(metaPath));
    const now = Date.now();
    const createdAt = prev?.createdAt ?? now;
    const updatedAt = args.touchUpdatedAt ? now : (prev?.updatedAt ?? now);
    const reason = String(args.reason || prev?.reason || "").trim() || "unknown";
    const status: CodexAccountStatusKey = args.status === "signed_in" ? "signed_in" : "signed_out";
    const accountId = args.accountId ? String(args.accountId).trim() || null : null;
    const userId = args.userId != null ? String(args.userId || "").trim() || null : (prev?.userId ?? null);
    const email = args.email != null ? String(args.email || "").trim() || null : (prev?.email ?? null);
    const plan = args.plan != null ? String(args.plan || "").trim() || null : (prev?.plan ?? null);

    const next: CodexAuthBackupMeta = {
      version: 1,
      id,
      createdAt,
      updatedAt,
      runtimeKey,
      signature,
      status,
      accountId,
      userId,
      email,
      plan,
      reason,
    };

    // 若不触碰时间戳且内容无变化，则直接返回，避免无意义写盘
    if (!args.touchUpdatedAt && prev) {
      const same =
        prev.signature === next.signature &&
        prev.status === next.status &&
        (prev.accountId ?? null) === (next.accountId ?? null) &&
        (prev.userId ?? null) === (next.userId ?? null) &&
        (prev.email ?? null) === (next.email ?? null) &&
        (prev.plan ?? null) === (next.plan ?? null) &&
        (prev.reason ?? "") === (next.reason ?? "") &&
        prev.createdAt === next.createdAt &&
        prev.updatedAt === next.updatedAt;
      if (same) return { ok: true, item: prev };
    }

    await writeFileAtomic(metaPath, Buffer.from(JSON.stringify(next, null, 2), "utf8"));
    return { ok: true, item: next };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
}

/**
 * 原子写入：先写入临时文件，再 rename 覆盖目标文件，避免中途写坏。
 */
async function writeFileAtomic(targetPath: string, data: Buffer | string): Promise<void> {
  const p = String(targetPath || "");
  const dir = path.dirname(p);
  const tmp = path.join(dir, `${path.basename(p)}.tmp-${randomUUID()}`);
  await fsp.writeFile(tmp, data);
  try {
    await fsp.rename(tmp, p);
  } catch {
    try { await fsp.unlink(p); } catch {}
    await fsp.rename(tmp, p);
  }
}

/**
 * 安全读取 JSON（失败返回 null）。
 */
async function readJsonSafe(filePath: string): Promise<any | null> {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    return JSON.parse(text.replace(/^\uFEFF/, "") || "null");
  } catch {
    return null;
  }
}

/**
 * 解析并规范化备份 meta（失败返回 null）。
 */
function normalizeMeta(raw: any): CodexAuthBackupMeta | null {
  try {
    if (!raw || typeof raw !== "object") return null;
    if (raw.version !== 1) return null;
    const id = String(raw.id || "").trim().toLowerCase();
    if (!isSafeAuthBackupId(id)) return null;
    const createdAt = Number(raw.createdAt);
    const updatedAt = Number(raw.updatedAt);
    if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
    const runtimeKey = String(raw.runtimeKey || "").trim();
    const signature = String(raw.signature || "").trim();
    const status: CodexAccountStatusKey = raw.status === "signed_in" ? "signed_in" : "signed_out";
    const accountId = raw.accountId != null ? String(raw.accountId || "").trim() || null : null;
    const userId = raw.userId != null ? String(raw.userId || "").trim() || null : null;
    const email = raw.email != null ? String(raw.email || "").trim() || null : null;
    const plan = raw.plan != null ? String(raw.plan || "").trim() || null : null;
    const reason = String(raw.reason || "").trim() || "unknown";
    return {
      version: 1,
      id,
      createdAt,
      updatedAt,
      runtimeKey,
      signature,
      status,
      accountId,
      userId,
      email,
      plan,
      reason,
    };
  } catch {
    return null;
  }
}

/**
 * 返回备份文件路径（auth/meta）。
 */
function resolveBackupPaths(runtimeKey: string, id: string): { authPath: string; metaPath: string } {
  const dir = getBackupDir(runtimeKey);
  const safeId = String(id || "").trim().toLowerCase();
  return {
    authPath: path.join(dir, `auth.${safeId}.json`),
    metaPath: path.join(dir, `meta.${safeId}.json`),
  };
}

/**
 * 枚举全局 auth.json 备份列表（按更新时间倒序）。
 */
export async function listCodexAuthBackupsAsync(runtimeKey: string): Promise<CodexAuthBackupItem[]> {
  const dir = getBackupDir(runtimeKey);
  try {
    if (!fs.existsSync(dir)) return [];
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const metas = entries
      .filter((e) => e.isFile() && /^meta\.[a-f0-9]{12,64}\.json$/i.test(e.name))
      .map((e) => path.join(dir, e.name));

    const items: CodexAuthBackupItem[] = [];
    for (const metaPath of metas) {
      const raw = await readJsonSafe(metaPath);
      const meta = normalizeMeta(raw);
      if (!meta) continue;
      const { authPath } = resolveBackupPaths(runtimeKey, meta.id);
      if (!fs.existsSync(authPath)) continue;
      items.push(meta);
    }

    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/**
 * 创建/更新指定签名的 auth.json 备份（同一签名仅保留一个“最新备份”）。
 */
export async function upsertCodexAuthBackupAsync(args: {
  runtimeKey: string;
  authJsonPath: string;
  signature: string;
  status: CodexAccountStatusKey;
  accountId: string | null;
  userId?: string | null;
  email?: string | null;
  plan?: string | null;
  reason: string;
}): Promise<{ ok: true; item: CodexAuthBackupItem } | { ok: false; error: string }> {
  try {
    const runtimeKey = String(args.runtimeKey || "").trim();
    if (!runtimeKey) return { ok: false, error: "missing runtimeKey" };
    const authJsonPath = String(args.authJsonPath || "").trim();
    if (!authJsonPath) return { ok: false, error: "missing authJsonPath" };
    if (!fs.existsSync(authJsonPath)) return { ok: false, error: "auth.json not found" };

    const signature = String(args.signature || "").trim();
    const id = backupIdFromSignature(signature);
    const { authPath, metaPath } = resolveBackupPaths(runtimeKey, id);
    const content = await fsp.readFile(authJsonPath);
    assertAuthContentMatchesAccount(content, args);
    await fsp.mkdir(path.dirname(authPath), { recursive: true });
    await writeFileAtomic(authPath, content);

    const now = Date.now();
    const prev = normalizeMeta(await readJsonSafe(metaPath));
    const createdAt = prev?.createdAt ?? now;
    const reason = String(args.reason || "").trim() || "unknown";
    const status: CodexAccountStatusKey = args.status === "signed_in" ? "signed_in" : "signed_out";
    const accountId = args.accountId ? String(args.accountId).trim() || null : null;
    const userId = args.userId != null ? String(args.userId || "").trim() || null : null;
    const email = args.email != null ? String(args.email || "").trim() || null : null;
    const plan = args.plan != null ? String(args.plan || "").trim() || null : null;
    const meta: CodexAuthBackupMeta = {
      version: 1,
      id,
      createdAt,
      updatedAt: now,
      runtimeKey,
      signature,
      status,
      accountId,
      userId,
      email,
      plan,
      reason,
    };
    await writeFileAtomic(metaPath, Buffer.from(JSON.stringify(meta, null, 2), "utf8"));
    return { ok: true, item: meta };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
}

/** 切换前保存现有凭据；无法确认身份或备份失败时阻止覆盖。 */
export async function preserveCodexAuthBeforeSwitchAsync(args: {
  runtimeKey: string;
  authJsonPath: string;
  getAccountInfo: () => Promise<CodexAccountInfo>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!String(args.authJsonPath || "").trim()) return { ok: false, error: "缺少认证文件路径" };
    try {
      await fsp.stat(args.authJsonPath);
    } catch (error: any) {
      if (error?.code === "ENOENT") return { ok: true };
      throw error;
    }
    const info = await args.getAccountInfo();
    const identity = resolveCodexAccountSignature(info);
    if (identity.status !== "signed_in")
      return { ok: false, error: "无法确认现有认证文件的账号，未覆盖当前凭据" };
    const saved = await upsertCodexAuthBackupAsync({
      runtimeKey: args.runtimeKey,
      authJsonPath: args.authJsonPath,
      ...identity,
      userId: info.userId,
      email: info.email,
      plan: info.plan,
      reason: "before-switch",
    });
    return saved.ok ? { ok: true } : { ok: false, error: saved.error };
  } catch (error) {
    return { ok: false, error: `保存当前账号失败，未切换账号：${String(error)}` };
  }
}

/**
 * 获取单个备份 meta（用于切换后同步更新 settings 等场景）。
 */
export async function readCodexAuthBackupMetaAsync(runtimeKey: string, id: string): Promise<CodexAuthBackupItem | null> {
  try {
    if (!isSafeAuthBackupId(id)) return null;
    const { metaPath, authPath } = resolveBackupPaths(runtimeKey, id);
    if (!fs.existsSync(metaPath) || !fs.existsSync(authPath)) return null;
    const raw = await readJsonSafe(metaPath);
    const meta = normalizeMeta(raw);
    return meta;
  } catch {
    return null;
  }
}

/**
 * 将指定备份覆盖写入到目标 `.codex/auth.json`（原子写入，失败返回错误）。
 */
export async function applyCodexAuthBackupAsync(args: {
  runtimeKey: string;
  backupId: string;
  targetAuthJsonPath: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const runtimeKey = String(args.runtimeKey || "").trim();
    const backupId = String(args.backupId || "").trim().toLowerCase();
    if (!runtimeKey) return { ok: false, error: "missing runtimeKey" };
    if (!isSafeAuthBackupId(backupId)) return { ok: false, error: "invalid backupId" };

    const { authPath } = resolveBackupPaths(runtimeKey, backupId);
    if (!fs.existsSync(authPath)) return { ok: false, error: "backup auth not found" };

    const target = String(args.targetAuthJsonPath || "").trim();
    if (!target) return { ok: false, error: "missing targetAuthJsonPath" };

    const content = await fsp.readFile(authPath);
    const meta = normalizeMeta(await readJsonSafe(resolveBackupPaths(runtimeKey, backupId).metaPath));
    if (!meta || meta.status !== "signed_in") return { ok: false, error: "无法确认备份账号，请重新记录账号" };
    assertAuthContentMatchesAccount(content, meta);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await writeFileAtomic(target, content);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
}

/**
 * 删除指定备份（auth/meta）。若文件不存在则视为成功。
 */
export async function deleteCodexAuthBackupAsync(args: {
  runtimeKey: string;
  backupId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const runtimeKey = String(args.runtimeKey || "").trim();
    if (!runtimeKey) return { ok: false, error: "missing runtimeKey" };
    const backupId = String(args.backupId || "").trim().toLowerCase();
    if (!isSafeAuthBackupId(backupId)) return { ok: false, error: "invalid backupId" };

    const removeFile = async (p: string): Promise<void> => {
      try {
        await fsp.unlink(p);
      } catch (e: any) {
        if (e && typeof e === "object" && (e as any).code === "ENOENT") return;
        throw e;
      }
    };
    const { authPath, metaPath } = resolveBackupPaths(runtimeKey, backupId);
    await removeFile(authPath);
    await removeFile(metaPath);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
}
