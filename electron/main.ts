// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Menu, screen, session, nativeTheme } from 'electron';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { ProxyAgent, setGlobalDispatcher, Agent } from 'undici';
import { PTYManager, setTermDebug } from "./pty";
import opentype from 'opentype.js';
import iconv from 'iconv-lite';
import projects, { IMPLEMENTATION_NAME as PROJECTS_IMPL } from "./projects/index";
import history, { purgeHistoryCacheIfOutdated } from "./history";
import { startHistoryIndexer, getIndexedSummaries, getIndexedDetails, getLastIndexerRoots, getLastIndexerRootsByProvider, stopHistoryIndexer, cacheDetails, getCachedDetails } from "./indexer";
import { getSessionsRootsFastAsync } from "./wsl";
import { getClaudeRootCandidatesFastAsync } from "./agentSessions/claude/discovery";
import { getGeminiRootCandidatesFastAsync } from "./agentSessions/gemini/discovery";
import { parseClaudeSessionFile } from "./agentSessions/claude/parser";
import { parseGeminiSessionFile, extractGeminiProjectHashFromPath, normalizeGeminiPathForHash } from "./agentSessions/gemini/parser";
import { sha256Hex } from "./agentSessions/shared/crypto";
import { tidyPathCandidate } from "./agentSessions/shared/path";
import { hasNonEmptyIOFromMessages } from "./agentSessions/shared/empty";
import { perfLogger } from "./log";
import settings, { ensureSettingsAutodetect, ensureFirstRunTerminalSelection, type ThemeSetting as SettingsThemeSetting, type AppSettings } from "./settings";
import { resolveWindowsShell, detectPwshExecutable } from "./shells";
import i18n from "./i18n";
import wsl from "./wsl";
import fileIndex from "./fileIndex";
import images from "./images";
import { installInputContextMenu } from "./contextMenu";
import { getQuitConfirmDialogTextForLocale } from "./locales/quitConfirm";
import { registerQuitConfirmIPC, requestQuitConfirmFromRenderer } from "./quitConfirmBridge";
import { CodexBridge, type CodexBridgeOptions } from "./codex/bridge";
import { applyCodexAuthBackupAsync, deleteCodexAuthBackupAsync, isSafeAuthBackupId, listCodexAuthBackupsAsync, readCodexAuthBackupMetaAsync, resolveCodexAccountSignature, resolveCodexAuthJsonPathAsync, upsertCodexAuthBackupAsync, upsertCodexAuthBackupMetaOnlyAsync } from "./codex/authBackups";
import { ensureAllCodexNotifications } from "./codex/config";
import { getClaudeUsageSnapshotAsync } from "./claude/usage";
import { getGeminiQuotaSnapshotAsync } from "./gemini/usage";
import storage from "./storage";
import { registerNotificationIPC, unregisterNotificationIPC } from "./notifications";
import { applyInstanceProfile, normalizeProfileId, resolveProfileUserDataDir } from "./instance";
import { getBaseUserDataDir, getFeatureFlags, updateFeatureFlags } from "./featureFlags";
import { readDebugConfig, getDebugConfig, onDebugChanged, watchDebugConfig, updateDebugConfig, resetDebugConfig, unwatchDebugConfig } from "./debugConfig";

// 使用 CommonJS 编译输出时，运行时环境会提供 `__dirname`，直接使用即可

let mainWindow: BrowserWindow | null = null;
let DIAG = false;
let quitConfirmed = false;
let quitConfirming = false;
function applyDebugGlobalsFromConfig(): void {
  try {
    const cfg = getDebugConfig();
    DIAG = !!(cfg?.global?.diagLog);
  } catch { DIAG = false; }
}
const APP_USER_MODEL_ID = 'com.codexflow.app';
const DEV_APP_USER_MODEL_ID = 'com.codexflow.app.dev';
const PROTOCOL_SCHEME = 'codexflow';
const ptyManager = new PTYManager(() => mainWindow);
// 会话期粘贴图片（保存后的 Windows 路径），用于退出时统一清理
const sessionPastedImages = new Set<string>();
const codexBridges = new Map<string, CodexBridge>();

// 注册“退出确认”渲染进程回包 IPC（用于自定义 UI 风格的确认弹窗）
try { registerQuitConfirmIPC(); } catch {}

// 记录每个渲染进程声明的活跃根集合，统一合并后再驱动 fileIndex，避免多窗口互相清空 watcher
const activeRootsBySender = new Map<number, Set<string>>();
const activeRootsSenderHooked = new Set<number>();

function applyMergedActiveRoots(): { closed: number; remain: number; trimmed: number } {
  const merged = new Set<string>();
  for (const roots of activeRootsBySender.values()) {
    for (const r of roots) merged.add(r);
  }
  const mergedList = Array.from(merged);
  return (fileIndex as any).setActiveRoots ? (fileIndex as any).setActiveRoots(mergedList) : { closed: 0, remain: 0, trimmed: 0 };
}

/**
 * 当仍有终端会话未关闭时，弹出确认框；返回用户是否选择“退出”。
 */
async function confirmQuitWithActiveTerminals(win: BrowserWindow | null, count: number): Promise<boolean> {
  try {
    // 优先使用渲染进程自定义弹窗（保持 UI 风格一致）
    const rendererRes = await requestQuitConfirmFromRenderer(win, count, { timeoutMs: 30_000 });
    if (rendererRes !== null) return rendererRes;

    // 回退：原生对话框（渲染进程不可用时）
    const L = getQuitConfirmDialogTextForLocale(i18n.getCurrentLocale?.(), count);
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      title: L.title,
      message: L.message,
      detail: L.detail,
      buttons: [L.cancel, L.quit],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
      normalizeAccessKeys: true,
    };
    const res = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return res.response === 1;
  } catch {
    // 若对话框弹出失败，为避免卡死退出流程，默认允许退出
    return true;
  }
}

/**
 * 外部控制台启动的短时间去重（防止重复点击/重复触发导致瞬间弹出多个窗口）。
 */
const externalConsoleLaunchGuard = new Map<string, number>();

/**
 * 判断是否需要跳过本次外部控制台启动（命中去重窗口则返回 true）。
 */
function shouldSkipExternalConsoleLaunch(key: string, windowMs: number = 1200): boolean {
  const now = Date.now();
  const win = Math.max(200, Math.min(10_000, Number(windowMs) || 0));
  const prev = externalConsoleLaunchGuard.get(key);
  if (typeof prev === "number" && now - prev >= 0 && now - prev < win) return true;
  externalConsoleLaunchGuard.set(key, now);
  // 轻量清理：避免 key 无限增长
  if (externalConsoleLaunchGuard.size > 500) {
    const threshold = now - 10 * 60_000;
    for (const [k, ts] of externalConsoleLaunchGuard.entries()) {
      if (ts < threshold) externalConsoleLaunchGuard.delete(k);
    }
    if (externalConsoleLaunchGuard.size > 800) externalConsoleLaunchGuard.clear();
  }
  return false;
}

/**
 * 解析 Windows 系统目录中的可执行文件路径，避免 PATH 缺失导致找不到。
 */
function resolveSystemBinary(bin: string): string {
  if (process.platform !== "win32") return bin;
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const full = path.join(root, "System32", bin);
  try {
    if (fs.existsSync(full)) return full;
  } catch {}
  return bin;
}

type SpawnDetachedSafeOptions = {
  timeoutMs?: number;
  detached?: boolean;
  windowsHide?: boolean;
  minAliveMs?: number;
  acceptExit0BeforeMinAliveMs?: boolean;
};

/**
 * 启动外部进程，并用 spawn/exit/error 判断是否真正启动成功。
 * - 若进程存活超过 minAliveMs，视为成功
 * - 若提前退出且 exitCode !== 0，视为失败
 * - 必须有超时，避免极端情况下 promise 悬挂
 */
function spawnDetachedSafe(file: string, argv: string[], options?: SpawnDetachedSafeOptions): Promise<boolean> {
  const timeoutMs = Math.max(200, Math.min(5000, Number(options?.timeoutMs ?? 1200)));
  const detached = options?.detached ?? true;
  const windowsHide = options?.windowsHide ?? true;
  const minAliveMs = Math.max(0, Math.min(2000, Number(options?.minAliveMs ?? 200)));
  const acceptExit0BeforeMinAliveMs = options?.acceptExit0BeforeMinAliveMs ?? true;
  return new Promise<boolean>((resolve) => {
    let done = false;
    let spawned = false;
    let aliveSatisfied = minAliveMs <= 0;
    let aliveTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (aliveTimer) clearTimeout(aliveTimer);
      resolve(ok);
    };

    let child: ReturnType<typeof spawn> | null = null;
    try {
      child = spawn(file, argv, { detached, stdio: "ignore", windowsHide });
    } catch {
      finish(false);
      return;
    }

    const timer = setTimeout(() => finish(false), timeoutMs);
    try { (timer as any).unref?.(); } catch {}

    try {
      child.once("spawn", () => {
        spawned = true;
        try { child?.unref(); } catch {}
        if (minAliveMs <= 0) {
          aliveSatisfied = true;
          finish(true);
          return;
        }
        aliveTimer = setTimeout(() => {
          aliveSatisfied = true;
          finish(true);
        }, minAliveMs);
        try { (aliveTimer as any).unref?.(); } catch {}
      });
      child.once("error", () => {
        try { child?.unref(); } catch {}
        finish(false);
      });
      child.once("exit", (code) => {
        if (!spawned) {
          finish(false);
          return;
        }
        if (code === 0) {
          if (aliveSatisfied || acceptExit0BeforeMinAliveMs) finish(true);
          else finish(false);
          return;
        }
        finish(false);
      });
    } catch {
      try { child?.unref(); } catch {}
      finish(false);
    }
  });
}

/**
 * 从 argv 中移除 profile 参数，避免“从当前实例继承 profile”。
 */
function stripProfileArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--profile") {
      i += 1;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--profile=")) {
      continue;
    }
    out.push(arg);
  }
  return out;
}

/**
 * 从 argv 中移除实例隔离相关参数（--profile / --user-data-dir），避免“从当前实例继承隔离参数”导致冲突。
 */
function stripInstanceIsolationArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--profile") {
      i += 1;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--profile=")) {
      continue;
    }
    if (arg === "--user-data-dir") {
      i += 1;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--user-data-dir=")) {
      continue;
    }
    out.push(arg);
  }
  return out;
}

/**
 * 生成一个自动 profileId（用于“一键打开新实例”）。
 */
/** 自动 profile 槽位数量：用于复用数据目录，避免每次双击都生成新目录导致磁盘无限增长。 */
const AUTO_PROFILE_POOL_SIZE = 4;
/** 自动 profile 下次优先尝试的槽位（轮询），减少反复探测同一槽位导致的“唤醒旧窗口”干扰。 */
let autoProfileNextSlot = 1;

/**
 * 生成一个固定槽位的自动 profileId（用于复用 userData 目录）。
 * 说明：同一槽位在不同启动间会复用同一份数据；并发占用时会尝试下一个槽位。
 */
function generateAutoProfileIdForSlot(slot: number): string {
  const n = Math.max(1, Math.min(64, Math.floor(Number(slot) || 1)));
  return `auto-${n}`;
}

/**
 * 构建自动多开时的 profile 候选列表：
 * - 优先尝试固定槽位 `auto-1...auto-N`（减少无意义的数据目录膨胀）
 * - 槽位都被占用时回退随机 profile，保证仍可继续多开
 */
function buildAutoProfileCandidates(): string[] {
  const ids: string[] = [];
  const total = Math.max(1, Math.min(64, Math.floor(Number(AUTO_PROFILE_POOL_SIZE) || 1)));
  const start = Math.max(1, Math.min(total, Math.floor(Number(autoProfileNextSlot) || 1)));
  autoProfileNextSlot = (start % total) + 1;
  for (let offset = 0; offset < total; offset++) {
    const slot = ((start - 1 + offset) % total) + 1;
    ids.push(normalizeProfileId(generateAutoProfileIdForSlot(slot)));
  }
  const fallback = normalizeProfileId(`auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  if (!ids.includes(fallback)) ids.push(fallback);
  return ids;
}

// Windows Terminal 启动参数：禁用隐藏，适度延长超时以兼容冷启动
const WT_VISIBLE_SPAWN_OPTS: SpawnDetachedSafeOptions = { windowsHide: false, timeoutMs: 3000, minAliveMs: 400 };

type CodexBridgeDescriptor = { key: string; options: CodexBridgeOptions };

function deriveCodexBridgeDescriptor(cfg: AppSettings): CodexBridgeDescriptor {
  try {
    const terminal = cfg?.terminal ?? "wsl";
    if (terminal === "wsl" && process.platform === "win32") {
      const raw = cfg?.distro;
      const distro = raw ? String(raw) : undefined;
      return { key: `wsl:${distro ?? ""}`, options: { mode: "wsl", wslDistro: distro } };
    }
  } catch {}
  return { key: "native", options: { mode: "native" } };
}

function disposeCodexBridgesExcept(activeKey: string) {
  if (codexBridges.size === 0) return;
  for (const [key, bridge] of Array.from(codexBridges.entries())) {
    if (key === activeKey) continue;
    try {
      bridge.dispose();
    } catch (e) {
      if (DIAG) {
        try { perfLogger.log(`[codex] dispose (stale) failed (${key}): ${String(e)}`); } catch {}
      }
    } finally {
      codexBridges.delete(key);
    }
  }
}

// 字体枚举缓存：避免每次打开设置都在主进程做大量同步 I/O/CPU 密集解析
let __fontsDetailedCache: Array<{ name: string; file?: string; monospace: boolean }> | null = null;
let __fontsDetailedCacheAt = 0;
let __fontsDetailedPending: Promise<{ ok: boolean; fonts: Array<{ name: string; file?: string; monospace: boolean }> }> | null = null;

const decodeRegOutput = (stdout: Buffer | string): string => {
  // 兼容性解码：优先识别 UTF-16LE，其次 UTF-8，最后回退到 GBK（常见于中文系统）
  try {
    if (Buffer.isBuffer(stdout)) {
      const buf = stdout as Buffer;
      // 带 BOM 的 UTF-16LE
      if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return iconv.decode(buf.slice(2), 'utf16le');
      }
      // 启发式判断 UTF-16LE：存在较多的 0x00 空字节
      const sample = buf.subarray(0, Math.min(buf.length, 512));
      let nullCount = 0;
      for (let i = 0; i < sample.length; i++) if (sample[i] === 0x00) nullCount++;
      if (nullCount > (sample.length / 8)) {
        return iconv.decode(buf, 'utf16le');
      }
      // 优先尝试 UTF-8（保证 ASCII 关键字如 REG_SZ 可识别），但若出现替换字符则回退
      const utf8Text = iconv.decode(buf, 'utf8');
      const utf8LooksValid = /\bREG_\w+\b/i.test(utf8Text) && !utf8Text.includes('\uFFFD');
      if (utf8LooksValid) {
        return utf8Text;
      }
      // 回退到 GBK（简体中文常见代码页），确保中文字体名称不被乱码
      const gbkText = iconv.decode(buf, 'gbk');
      const gbkLooksValid = /\bREG_\w+\b/i.test(gbkText) && !gbkText.includes('\uFFFD');
      if (gbkLooksValid) {
        return gbkText;
      }
      // 若两者均存在替换字符，优先返回结构更完整的 GBK 结果
      return gbkText.length >= utf8Text.length ? gbkText : utf8Text;
    }
    // 非 Buffer 情况：直接返回字符串
    return String(stdout || '');
  } catch {
    try {
      return Buffer.isBuffer(stdout) ? (stdout as Buffer).toString('utf8') : String(stdout || '');
    } catch {
      return '';
    }
  }
};

function disposeAllPtys() {
  try { ptyManager.disposeAll(); } catch (e) { /* noop */ }
}

function disposeCodexBridges() {
  if (codexBridges.size === 0) return;
  for (const [key, bridge] of codexBridges.entries()) {
    try {
      bridge.dispose();
    } catch (e) {
      if (DIAG) {
        try { perfLogger.log(`[codex] dispose failed (${key}): ${String(e)}`); } catch {}
      }
    } finally {
      codexBridges.delete(key);
    }
  }
}

async function cleanupPastedImages() {
  try {
    if (sessionPastedImages.size === 0) return;
    const toTrash = Array.from(sessionPastedImages);
    sessionPastedImages.clear();
    for (const p of toTrash) {
      try {
        if (fs.existsSync(p)) {
          // 彻底删除粘贴的临时图片（无回收站回退）
          try { await fsp.rm(p, { force: true }); } catch {}
        }
      } catch {}
    }
  } catch {}
}

function resolveCodexBridgeTarget(): CodexBridgeDescriptor {
  return deriveCodexBridgeDescriptor(settings.getSettings());
}

function ensureCodexBridge(): CodexBridge {
  const { key, options } = resolveCodexBridgeTarget();
  let bridge = codexBridges.get(key);
  if (!bridge) {
    bridge = new CodexBridge(options);
    codexBridges.set(key, bridge);
  }
  return bridge;
}

/**
 * 启用“记录账号”时：在刷新账号信息的同时检测账号签名变化，并自动备份当前环境的 `.codex/auth.json`。
 */
async function maybeAutoBackupCodexAuthJsonOnAccountRefresh(info: any, runtime: CodexBridgeDescriptor): Promise<void> {
  try {
    const cfg = settings.getSettings() as any;
    const recordEnabled = !!cfg?.codexAccount?.recordEnabled;
    if (!recordEnabled) return;

    const runtimeKey = String(runtime?.key || "").trim() || "native";
    const { status, accountId, signature } = resolveCodexAccountSignature(info);

    const lastMapRaw = cfg?.codexAccount?.lastSeenSignatureByRuntime;
    const lastMap = (lastMapRaw && typeof lastMapRaw === "object") ? (lastMapRaw as Record<string, string>) : {};
    const lastSig = String(lastMap[runtimeKey] || "").trim();

    const normalizeOptionalField = (value: any): string | undefined => {
      const s = String(value ?? "").trim();
      return s ? s : undefined;
    };
    const userId = normalizeOptionalField(info?.userId);
    const email = normalizeOptionalField(info?.email);
    const plan = normalizeOptionalField(info?.plan);

    // 未登录：仅记录签名，避免反复尝试备份
    if (status === "signed_out") {
      const nextMap = { ...lastMap, [runtimeKey]: signature };
      settings.updateSettings({ codexAccount: { ...cfg?.codexAccount, recordEnabled: true, lastSeenSignatureByRuntime: nextMap } as any });
      return;
    }

    const authRes = await resolveCodexAuthJsonPathAsync({ key: runtimeKey, options: runtime.options });
    if (!authRes.ok) return;

    // 同一签名：优先补齐备份 meta（例如套餐/邮箱还没拿到时），若备份被删除则降级为重建。
    if (lastSig && lastSig === signature) {
      const metaRes = await upsertCodexAuthBackupMetaOnlyAsync({
        runtimeKey,
        signature,
        status,
        accountId,
        userId,
        email,
        plan,
      });
      if (!metaRes.ok) {
        const backupRes = await upsertCodexAuthBackupAsync({
          runtimeKey,
          authJsonPath: authRes.authJsonPath,
          signature,
          status,
          accountId,
          userId: userId ?? null,
          email: email ?? null,
          plan: plan ?? null,
          reason: "auto-record",
        });
        if (!backupRes.ok) return;
      }
      const nextMap = { ...lastMap, [runtimeKey]: signature };
      settings.updateSettings({ codexAccount: { ...cfg?.codexAccount, recordEnabled: true, lastSeenSignatureByRuntime: nextMap } as any });
      return;
    }

    const reason = lastSig ? "auto-record" : "auto-record-init";
    const backupRes = await upsertCodexAuthBackupAsync({
      runtimeKey,
      authJsonPath: authRes.authJsonPath,
      signature,
      status,
      accountId,
      userId: userId ?? null,
      email: email ?? null,
      plan: plan ?? null,
      reason,
    });
    if (!backupRes.ok) return;

    const nextMap = { ...lastMap, [runtimeKey]: signature };
    settings.updateSettings({ codexAccount: { ...cfg?.codexAccount, recordEnabled: true, lastSeenSignatureByRuntime: nextMap } as any });
  } catch {}
}

// 统一配置/更新全局代理（支持：自定义/系统代理；并同步给 CLI 及 WSL 环境变量）
let appliedProxySig = "";
function redactProxy(uri: string): string {
  try {
    const u = new URL(uri);
    const auth = u.username || u.password ? "***@" : "";
    return `${u.protocol}//${auth}${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return uri.replace(/\/\/([^@]+)@/, "//***@");
  }
}

function chooseFromElectronProxyString(spec: string): string | null {
  // 参考 Chromium 语法：
  // 返回形如 "DIRECT"、"PROXY host:port; DIRECT"、"SOCKS5 host:port; PROXY ..."
  const parts = String(spec || "").split(";").map((s) => s.trim().toUpperCase());
  // 优先 SOCKS5/SOCKS
  for (const p of parts) {
    const m = p.match(/^SOCKS5\s+([^;\s]+)$/) || p.match(/^SOCKS\s+([^;\s]+)$/);
    if (m && m[1]) return `socks5://${m[1]}`;
  }
  // 再尝试 HTTP 代理（PROXY）
  for (const p of parts) {
    const m = p.match(/^PROXY\s+([^;\s]+)$/);
    if (m && m[1]) return `http://${m[1]}`;
  }
  return null;
}

/**
 * 为 Promise 添加超时保护：超时或失败返回 null，避免启动阶段因系统代理解析等操作无限期等待。
 */
async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  const ms = Math.max(200, Math.min(10_000, Number(timeoutMs) || 0));
  return await new Promise<T | null>((resolve) => {
    let done = false;
    const finish = (value: T | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), ms);
    try { (timer as any).unref?.(); } catch {}
    promise.then((v) => { try { clearTimeout(timer); } catch {} finish(v); }).catch(() => { try { clearTimeout(timer); } catch {} finish(null); });
  });
}

async function detectSystemProxyUrl(): Promise<string | null> {
  try {
    const s = session.defaultSession;
    if (!s) return null;
    const spec = await promiseWithTimeout(s.resolveProxy('https://chatgpt.com'), 1500);
    if (!spec) return null;
    const uri = chooseFromElectronProxyString(spec);
    return uri;
  } catch {
    return null;
  }
}

async function configureOrUpdateProxy(): Promise<void> {
  try {
    const cfg = settings.getSettings() as any;
    const net = (cfg && cfg.network) ? cfg.network : {};
    let uri: string | null = null;
    let noProxy = String(net.noProxy || process.env.NO_PROXY || '').trim();

    if (net.proxyEnabled === false) {
      // 显式关闭代理
      setGlobalDispatcher(new Agent());
      delete (process as any).env.CODEXFLOW_PROXY;
      delete (process as any).env.HTTPS_PROXY;
      delete (process as any).env.HTTP_PROXY;
      if (noProxy) (process as any).env.NO_PROXY = noProxy; else delete (process as any).env.NO_PROXY;
      const sig = `off|${noProxy}`;
      if (sig !== appliedProxySig) {
        appliedProxySig = sig;
        try { perfLogger.log(`[codex] Proxy disabled`); } catch {}
      }
      return;
    }

    const mode = (net.proxyMode as 'system' | 'custom') || 'system';
    if (mode === 'custom') {
      const raw = String(net.proxyUrl || '').trim();
      if (raw) {
        try { uri = new URL(raw).toString(); } catch { uri = raw; }
      }
    }
    if (!uri) {
      // 环境变量回退
      const envRaw = (process.env.CODEXFLOW_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();
      if (envRaw) uri = envRaw;
    }
    if (!uri && mode === 'system') {
      uri = await detectSystemProxyUrl();
    }

    if (!uri) {
      // 未检测到代理：使用直连
      setGlobalDispatcher(new Agent());
      const sig = `direct|${noProxy}`;
      if (sig !== appliedProxySig) {
        appliedProxySig = sig;
        try { perfLogger.log(`[codex] Proxy: DIRECT`); } catch {}
      }
      return;
    }

    // 应用代理并同步环境变量（供子进程与 WSL 使用）
    setGlobalDispatcher(new ProxyAgent(uri));
    (process as any).env.CODEXFLOW_PROXY = uri;
    (process as any).env.HTTPS_PROXY = uri;
    (process as any).env.HTTP_PROXY = uri;
    if (noProxy) (process as any).env.NO_PROXY = noProxy; else delete (process as any).env.NO_PROXY;

    const sig = `${uri}|${noProxy}`;
    if (sig !== appliedProxySig) {
      appliedProxySig = sig;
      try { perfLogger.log(`[codex] Using proxy: ${redactProxy(uri)}${noProxy ? ` (NO_PROXY=${noProxy})` : ''}`); } catch {}
    }
  } catch (err) {
    try { perfLogger.log(`[codex] Proxy setup failed: ${err instanceof Error ? err.message : String(err)}`); } catch {}
  }
}

function rectsOverlap(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  const horizontal = a.x < b.x + b.width && a.x + a.width > b.x;
  const vertical = a.y < b.y + b.height && a.y + a.height > b.y;
  return horizontal && vertical;
}

/**
 * 确保窗口落在可见屏幕范围内（多显示器/分辨率变更后，窗口可能跑到屏幕外）。
 */
function ensureWindowInView(win: BrowserWindow): void {
  try {
    const bounds = win.getBounds();
    const displays = screen.getAllDisplays();
    const visible = displays.some((d) => rectsOverlap(bounds, d.workArea));
    if (visible) return;

    const workArea = screen.getPrimaryDisplay().workArea;
    const width = Math.min(Math.max(bounds.width || 1280, 640), workArea.width);
    const height = Math.min(Math.max(bounds.height || 800, 480), workArea.height);
    const x = workArea.x + Math.floor((workArea.width - width) / 2);
    const y = workArea.y + Math.floor((workArea.height - height) / 2);
    win.setBounds({ x, y, width, height });
    try { perfLogger.log(`[WIN] ensureInView moved bounds=${JSON.stringify({ x, y, width, height })}`); } catch {}
  } catch {}
}

/**
 * 强制显示并聚焦窗口：处理 Windows “从快捷方式以最小化启动”或“未抢到前台”的情况。
 */
function forceShowWindow(win: BrowserWindow, reason: string): void {
  try {
    const minimized = (() => { try { return win.isMinimized(); } catch { return false; } })();
    const visible = (() => { try { return win.isVisible(); } catch { return false; } })();
    try { perfLogger.log(`[WIN] forceShow reason=${reason} minimized=${minimized ? 1 : 0} visible=${visible ? 1 : 0}`); } catch {}
    try { if (minimized) win.restore(); } catch {}
    try { win.show(); } catch {}
    try { win.focus(); } catch {}
    try { (win as any).moveTop?.(); } catch {}
    try { app.focus({ steal: true } as any); } catch { try { app.focus(); } catch {} }
  } catch {}
}

function ensureDetachedDevtoolsInView(): void {
  const wc = mainWindow?.webContents;
  if (!wc) return;
  const devtools = wc.devToolsWebContents;
  if (!devtools) return;
  const devtoolsWindow = BrowserWindow.fromWebContents(devtools);
  if (!devtoolsWindow || devtoolsWindow === mainWindow) return;

  const currentBounds = devtoolsWindow.getBounds();
  const displays = screen.getAllDisplays();
  const visible = displays.some((display) => rectsOverlap(currentBounds, display.workArea));

  if (!visible) {
    const workArea = screen.getPrimaryDisplay().workArea;
    const width = Math.min(Math.max(currentBounds.width || 900, 600), workArea.width);
    const height = Math.min(Math.max(currentBounds.height || 700, 480), workArea.height);
    const x = workArea.x + Math.floor((workArea.width - width) / 2);
    const y = workArea.y + Math.floor((workArea.height - height) / 2);
    devtoolsWindow.setBounds({ x, y, width, height });
  }

  devtoolsWindow.show();
  devtoolsWindow.focus();
}

function resolveAppIcon(): string | undefined {
  try {
    const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
    if (app.isPackaged) {
      const packagedIcon = path.join(process.resourcesPath, iconName);
      if (fs.existsSync(packagedIcon)) return packagedIcon;
    } else {
      const devIcon = path.join(process.cwd(), 'build', iconName);
      if (fs.existsSync(devIcon)) return devIcon;
    }
    const packagedFallback = path.join(process.resourcesPath, 'icon.png');
    if (app.isPackaged && fs.existsSync(packagedFallback)) return packagedFallback;
    const devFallback = path.join(process.cwd(), 'build', 'icon.png');
    if (!app.isPackaged && fs.existsSync(devFallback)) return devFallback;
  } catch {}
  return undefined;
}

function resolveRendererEntry(): string {
  const appPath = app.getAppPath();
  const dirBasedHtml = path.join(__dirname, '..', '..', 'web', 'dist', 'index.html');
  const packagedHtml = path.join(appPath, 'web', 'dist', 'index.html');
  const unpackedHtml = path.join(process.resourcesPath, 'app.asar.unpacked', 'web', 'dist', 'index.html');
  const resourcesHtml = path.join(process.resourcesPath, 'web', 'dist', 'index.html');
  const projectHtml = path.join(process.cwd(), 'web', 'dist', 'index.html');
  const candidates = app.isPackaged
    ? [packagedHtml, dirBasedHtml, unpackedHtml, resourcesHtml, projectHtml]
    : [projectHtml, dirBasedHtml, packagedHtml, resourcesHtml];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  // 缺省返回候选列表首项，即便缺失也能让 loadFile 给出明确错误
  return candidates[0] || projectHtml;
}

function ensureWindowsDevShortcut(appUserModelId: string, iconPath?: string) {
  try {
    const startMenuRoot = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const shortcutDir = path.join(startMenuRoot, 'CodexFlow');
    const shortcutPath = path.join(shortcutDir, 'CodexFlow Dev.lnk');
    try { fs.mkdirSync(shortcutDir, { recursive: true }); } catch {}
    const target = process.execPath;
    const cwd = path.dirname(target);
    let current: Electron.ShortcutDetails | null = null;
    try { current = shell.readShortcutLink(shortcutPath); } catch {}
    const shortcutDetails: Electron.ShortcutDetails = {
      appUserModelId,
      target,
      cwd,
      description: 'CodexFlow (Dev)',
    };
    if (iconPath) {
      shortcutDetails.icon = iconPath;
      shortcutDetails.iconIndex = 0;
    }
    const needsUpdate = !current
      || current.target !== shortcutDetails.target
      || current.appUserModelId !== shortcutDetails.appUserModelId
      || (!!shortcutDetails.icon && current.icon !== shortcutDetails.icon);
    if (needsUpdate) {
      const mode: 'create' | 'update' | 'replace' = current ? 'update' : 'create';
      shell.writeShortcutLink(shortcutPath, mode, shortcutDetails);
      try { perfLogger.log(`[notifications] ensure dev shortcut mode=${mode} path=${shortcutPath}`); } catch {}
    }
  } catch (error) {
    try { perfLogger.log(`[notifications] ensure dev shortcut failed: ${String(error)}`); } catch {}
  }
}

function ensureWindowsUserShortcut(appUserModelId: string, iconPath?: string) {
  try {
    const startMenuRoot = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const shortcutDir = path.join(startMenuRoot, 'CodexFlow');
    const shortcutPath = path.join(shortcutDir, 'CodexFlow.lnk');
    try { fs.mkdirSync(shortcutDir, { recursive: true }); } catch {}
    const target = process.execPath;
    const cwd = path.dirname(target);
    let current: Electron.ShortcutDetails | null = null;
    try { current = shell.readShortcutLink(shortcutPath); } catch {}
    const shortcutDetails: Electron.ShortcutDetails = {
      appUserModelId,
      target,
      cwd,
      description: 'CodexFlow',
    };
    if (iconPath) {
      shortcutDetails.icon = iconPath;
      shortcutDetails.iconIndex = 0;
    }
    const needsUpdate = !current
      || current.target !== shortcutDetails.target
      || current.appUserModelId !== shortcutDetails.appUserModelId
      || (!!shortcutDetails.icon && current.icon !== shortcutDetails.icon);
    if (needsUpdate) {
      const mode: 'create' | 'update' | 'replace' = current ? 'update' : 'create';
      shell.writeShortcutLink(shortcutPath, mode, shortcutDetails);
      try { perfLogger.log(`[notifications] ensure user shortcut mode=${mode} path=${shortcutPath}`); } catch {}
    }
  } catch (error) {
    try { perfLogger.log(`[notifications] ensure user shortcut failed: ${String(error)}`); } catch {}
  }
}

function setupWindowsNotifications(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const appUserModelId = app.isPackaged ? APP_USER_MODEL_ID : DEV_APP_USER_MODEL_ID;
  try { app.setAppUserModelId(appUserModelId); } catch (error) {
    try { perfLogger.log(`[notifications] setAppUserModelId failed: ${String(error)}`); } catch {}
  }
  const iconPath = resolveAppIcon();
  if (app.isPackaged) ensureWindowsUserShortcut(appUserModelId, iconPath);
  else ensureWindowsDevShortcut(appUserModelId, iconPath);
  return appUserModelId;
}

function registerProtocol(): void {
  try {
    let registered = false;
    if (app.isPackaged) {
      registered = app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
    } else {
      const extra = (() => {
        try {
          const target = process.argv[1];
          if (!target) return [];
          return [path.resolve(target)];
        } catch { return []; }
      })();
      registered = app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, extra);
    }
    // 与通知模块的 toastXml 保持同一协议，避免后续改动导致 Windows Action Center 无法激活
    try { perfLogger.log(`[notifications] protocol ${PROTOCOL_SCHEME} registered=${registered}`); } catch {}
  } catch (error) {
    try { perfLogger.log(`[notifications] protocol register failed: ${String(error)}`); } catch {}
  }
}

function extractProtocolUrl(argv: string[] | readonly string[] | undefined | null): string | null {
  try {
    if (!argv) return null;
    const prefix = `${PROTOCOL_SCHEME.toLowerCase()}://`;
    for (const arg of argv) {
      if (typeof arg !== 'string') continue;
      if (arg.toLowerCase().startsWith(prefix)) return arg;
    }
  } catch {}
  return null;
}

function focusTabFromProtocol(rawUrl?: string | null) {
  if (!rawUrl) return;
  try {
    const parsed = new URL(rawUrl);
    const intent = parsed.hostname || parsed.pathname.replace(/^\//, '');
    if (intent !== 'focus-tab') return;
    const tabId = parsed.searchParams.get('tabId') ?? parsed.searchParams.get('tab') ?? parsed.searchParams.get('id');
    if (!tabId) return;
    const handleWindow = (target: BrowserWindow) => {
      if (target.isMinimized()) {
        try { target.restore(); } catch {}
      }
      try { target.show(); target.focus(); } catch {}
      const wc = target.webContents;
      const dispatch = () => {
        try { perfLogger.log(`[notifications] protocol focus tabId=${tabId}`); } catch {}
        try { wc.send('notifications:focus-tab', { tabId }); } catch {}
      };
      if (wc.isDestroyed()) return;
      if (wc.isLoading()) wc.once('did-finish-load', dispatch);
      else dispatch();
    };
    if (mainWindow) {
      handleWindow(mainWindow);
      return;
    }
    app.once('browser-window-created', (_event, win) => {
      if (!win) return;
      const deliver = () => handleWindow(win);
      const wc = win.webContents;
      if (!wc || wc.isDestroyed()) return;
      if (wc.isLoading()) wc.once('did-finish-load', deliver);
      else deliver();
    });
  } catch (error) {
    try { perfLogger.log(`[notifications] protocol focus failed: ${String(error)}`); } catch {}
  }
}


function createWindow() {
  const windowIcon = resolveAppIcon();
  try { perfLogger.log(`[WIN] create pid=${process.pid} userData=${app.getPath('userData')}`); } catch {}
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: windowIcon,
    // 恢复系统默认标题栏/菜单栏布局
    autoHideMenuBar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // 显式允许开发者工具（默认即为 true，此处明确写出以避免歧义）
      devTools: true
    },
    show: true
  });

  mainWindow.webContents.on('devtools-opened', () => {
    setTimeout(() => { try { ensureDetachedDevtoolsInView(); } catch {} }, 0);
  });

  // 安装输入框右键菜单（撤销/重做/剪切/复制/粘贴/全选，支持多语言）
  try { installInputContextMenu(mainWindow.webContents); } catch {}

  // 窗口可见性兜底：避免多开实例“只有进程没窗口”的误感知
  try {
    const win = mainWindow;
    win.once('ready-to-show', () => {
      try { ensureWindowInView(win); } catch {}
      try { forceShowWindow(win, 'ready-to-show'); } catch {}
    });
    const t = setTimeout(() => {
      try { ensureWindowInView(win); } catch {}
      try { forceShowWindow(win, 'timeout'); } catch {}
    }, 800);
    try { (t as any).unref?.(); } catch {}
  } catch {}

  // 初始按系统主题设置原生主题与标题栏颜色（避免启动阶段因同步设置/WSL 探测阻塞而不出窗口）
  try {
    const fallbackMode: 'light' | 'dark' = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    applyTitleBarTheme(fallbackMode, 'system');
  } catch {}

  const devUrl = process.env.DEV_SERVER_URL;
  if (DIAG) { try { perfLogger.log(`[WIN] create BrowserWindow devUrl=${devUrl || ''}`); } catch {} }
  if (devUrl && /^https?:/i.test(devUrl)) {
    if (DIAG) { try { perfLogger.log(`[WIN] loadURL ${devUrl}`); } catch {} }
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const entryFile = resolveRendererEntry();
    if (DIAG) { try { perfLogger.log(`[WIN] loadFile ${entryFile}`); } catch {} }
    mainWindow.loadFile(entryFile);
    // 支持通过统一调试配置强制打开 DevTools（无论是否走本地文件或打包产物）
    try {
      const cfg = getDebugConfig();
      if (cfg?.global?.openDevtools) mainWindow.webContents.openDevTools({ mode: 'detach' });
    } catch {}
  }

  // 渲染进程诊断钩子
  if (DIAG) try {
    const wc = mainWindow.webContents;
    wc.on('did-start-loading', () => { try { perfLogger.log('[WC] did-start-loading'); } catch {} });
    wc.on('dom-ready', () => { try { perfLogger.log('[WC] dom-ready'); } catch {} });
    wc.on('did-finish-load', () => { try { perfLogger.log('[WC] did-finish-load'); } catch {} });
    wc.on('did-frame-finish-load', (_e, isMain) => { try { perfLogger.log(`[WC] did-frame-finish-load main=${isMain}`); } catch {} });
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
      try { perfLogger.log(`[WC] did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL}`); } catch {}
    });
    wc.on('did-navigate', (_e, url) => { try { perfLogger.log(`[WC] did-navigate url=${url}`); } catch {} });
    wc.on('did-navigate-in-page', (_e, url) => { try { perfLogger.log(`[WC] did-navigate-in-page url=${url}`); } catch {} });
    wc.on('render-process-gone', (_e, details) => { try { perfLogger.log(`[WC] render-process-gone reason=${(details as any)?.reason} exitCode=${(details as any)?.exitCode}`); } catch {} });
    wc.on('unresponsive', () => { try { perfLogger.log('[WC] unresponsive'); } catch {} });
    wc.on('console-message', (_e, level, message, line, sourceId) => {
      try { perfLogger.log(`[WC.console] level=${level} ${sourceId}:${line} ${message}`); } catch {}
    });
  } catch {}

  // 关闭窗口/退出应用前：若仍有终端会话未关闭，弹窗确认（避免误关导致任务中断）
  mainWindow.on("close", (event) => {
    try {
      if (quitConfirmed) return;
      const count = ptyManager.getActiveSessionCount();
      if (count <= 0) return;
      event.preventDefault();
      if (quitConfirming) return;
      quitConfirming = true;
      const win = mainWindow;
      void (async () => {
        try {
          const ok = await confirmQuitWithActiveTerminals(win, count);
          if (!ok) return;
          quitConfirmed = true;
          try { app.quit(); } catch {}
        } finally {
          quitConfirming = false;
        }
      })();
    } catch {}
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 统一应用标题栏主题色（Windows）
function applyTitleBarTheme(mode: 'light' | 'dark', source?: SettingsThemeSetting) {
  try {
    if (!mainWindow) return;
    const themeSource: SettingsThemeSetting | undefined = (source === 'light' || source === 'dark' || source === 'system') ? source : undefined;
    if (themeSource) {
      try { nativeTheme.themeSource = themeSource; } catch {}
    }
    const effectiveMode: 'light' | 'dark' = (() => {
      if (themeSource === 'light' || themeSource === 'dark') return themeSource;
      if (themeSource === 'system') {
        return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
      }
      return mode === 'dark' ? 'dark' : 'light';
    })();
    const isDark = effectiveMode === 'dark';
    // 与 web/src/index.css 中的 --cf-app-bg 完全一致（GitHub Primer 配色）
    const bar = isDark ? '#22272e' : '#ffffff';
    const symbols = isDark ? '#adbac7' : '#24292f';
    // 1) 统一系统主题（影响原生菜单/对话框/窗口框架）
    if (!themeSource) {
      try { nativeTheme.themeSource = isDark ? 'dark' : 'light'; } catch {}
    }
    // 2) 若启用了 overlay（未来可能切换），也同步覆盖色
    try { (mainWindow as any).setTitleBarOverlay?.({ color: bar, symbolColor: symbols, height: 32 }); } catch {}
    // 3) 背景色尽量保持一致（对默认框架影响有限，但无副作用）
    try { mainWindow.setBackgroundColor(bar); } catch {}
  } catch {}
}

// IPC: 渲染层请求同步标题栏主题
ipcMain.handle('app.setTitleBarTheme', async (_e, payload: { mode?: string; source?: string } | string) => {
  try {
    let mode: 'light' | 'dark' = 'light';
    let source: SettingsThemeSetting | undefined;
    if (typeof payload === 'string') {
      mode = payload === 'dark' ? 'dark' : 'light';
    } else if (payload && typeof payload === 'object') {
      mode = payload.mode === 'dark' ? 'dark' : 'light';
      if (payload.source === 'light' || payload.source === 'dark' || payload.source === 'system') {
        source = payload.source;
      }
    }
    applyTitleBarTheme(mode, source);
    return { ok: true } as any;
  } catch (e: any) {
    return { ok: false, error: String(e) } as any;
  }
});

// Single instance lock
const instanceProfile = applyInstanceProfile();
const gotLock = app.requestSingleInstanceLock({ profileId: instanceProfile.profileId } as any);
try { perfLogger.log(`[INSTANCE] pid=${process.pid} profile=${instanceProfile.profileId} userData=${instanceProfile.userDataDir} gotLock=${gotLock ? 1 : 0}`); } catch {}
if (!gotLock) {
  // 锁获取失败：必须尽快退出
  // - 避免残留为无窗口后台进程
  // - 避免被“自动多开”探测误判为成功（否则会只唤醒已有实例，无法继续打开第三/第四个实例）
  try { perfLogger.log(`[INSTANCE] lock denied -> quitting pid=${process.pid}`); } catch {}
  // 立即强制退出（app.quit 在少数环境下可能被句柄拖住）
  try { app.exit(0); } catch {}
  try {
    const t = setTimeout(() => {
      try { process.exit(0); } catch {}
    }, 200);
    try { (t as any).unref?.(); } catch {}
  } catch {}
  try { app.quit(); } catch {}
} else {
  /**
   * 处理“二次启动”：
   * - 优先处理协议激活（如 Windows 通知点击）
   * - 若启用实验性多实例：当二次启动未指定 `--profile` 时，自动拉起一个新的 profile 实例
   * - 否则聚焦现有窗口（保持单实例体验）
   */
  async function handleSecondInstance(argv: readonly string[]): Promise<void> {
    const url = extractProtocolUrl(argv as any);
    if (url) {
      focusTabFromProtocol(url);
      return;
    }
    try {
      const flags = getFeatureFlags();
      const enabled = !!flags.multiInstanceEnabled;
      if (enabled) {
        const hasProfileArg = stripProfileArgs(argv).length !== argv.length;
        if (!hasProfileArg) {
          const baseArgs = stripInstanceIsolationArgs(process.argv.slice(1));
          const baseUserDataDir = getBaseUserDataDir();
          const candidates = buildAutoProfileCandidates();
          for (const profileId of candidates) {
            const userDataDir = resolveProfileUserDataDir(baseUserDataDir, profileId);
            const spawnArgs = [...baseArgs, "--profile", profileId, "--user-data-dir", userDataDir];
            try { perfLogger.log(`[INSTANCE] spawn profile=${profileId} userData=${userDataDir}`); } catch {}
            const launched = await spawnDetachedSafe(process.execPath, spawnArgs, { timeoutMs: 2000, minAliveMs: 250, windowsHide: true, acceptExit0BeforeMinAliveMs: false });
            if (launched) {
              try { perfLogger.log(`[INSTANCE] spawn ok profile=${profileId}`); } catch {}
              return;
            }
            try { perfLogger.log(`[INSTANCE] spawn failed profile=${profileId}`); } catch {}
          }
        }
      }
    } catch {}
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  }

  app.on("second-instance", (_event, argv) => {
    void handleSecondInstance(argv as any);
  });

  app.whenReady().then(() => {
    // 加载统一调试配置并建立监听
    try { readDebugConfig(); applyDebugGlobalsFromConfig(); watchDebugConfig(); } catch {}
    // Windows：尽早设置 AUMID（建议在创建窗口前完成）
    try {
      if (process.platform === 'win32') {
        const appUserModelId = app.isPackaged ? APP_USER_MODEL_ID : DEV_APP_USER_MODEL_ID;
        if (appUserModelId) app.setAppUserModelId(appUserModelId);
      }
    } catch {}
    try {
      onDebugChanged(() => {
        try { applyDebugGlobalsFromConfig(); } catch {}
        // 主进程 PTY 调试开关热更新
        try { setTermDebug(!!getDebugConfig().terminal.pty.debug); } catch {}
        // 广播给所有窗口
        try { for (const win of BrowserWindow.getAllWindows()) { win.webContents.send('debug:changed'); } } catch {}
        // DevTools 强制打开（仅当配置为 true 且窗口已存在）
        try { const cfg = getDebugConfig(); if (cfg?.global?.openDevtools) mainWindow?.webContents.openDevTools({ mode: 'detach' }); } catch {}
      });
    } catch {}
    try { i18n.registerI18nIPC(); } catch {}
    // 构建应用菜单（包含 Toggle Developer Tools）
    try { setupAppMenu(); } catch {}
    try { createWindow(); } catch (e) { if (DIAG) { try { perfLogger.log(`[BOOT] createWindow error: ${String(e)}`); } catch {} } }
    focusTabFromProtocol(extractProtocolUrl(process.argv));
    // 启动时的耗时初始化放到后台执行：避免新实例因外部命令/代理探测阻塞而“无窗口常驻后台”
    void (async () => {
      try { perfLogger.log(`[BOOT] background init start pid=${process.pid}`); } catch {}
      // 一次性迁移：旧版 settings.json 中的 codexTraceEnabled -> debug.config.jsonc.codex.tuiTrace
      try {
        const s = settings.getSettings() as any;
        if (Object.prototype.hasOwnProperty.call(s, 'codexTraceEnabled')) {
          const wanted = !!s.codexTraceEnabled;
          const cur = getDebugConfig();
          if (!!cur?.codex?.tuiTrace !== wanted) {
            try { updateDebugConfig({ codex: { tuiTrace: wanted } } as any); } catch {}
          }
          // 清理旧字段：通过将其置为 undefined 来覆盖并从 JSON 中移除
          try { settings.updateSettings({ codexTraceEnabled: undefined } as any); } catch {}
        }
      } catch {}
      // 统一配置/更新全局代理（支持 Codex、fetch 等所有 undici 请求）
      try { await configureOrUpdateProxy(); } catch {}
      try { perfLogger.log(`[BOOT] proxy ready`); } catch {}
      const appUserModelId = setupWindowsNotifications();
      registerProtocol();
      try { perfLogger.log(`[BOOT] Using projects implementation: ${PROJECTS_IMPL}`); } catch {}
      if (DIAG) { try { perfLogger.log(`[BOOT] userData=${app.getPath('userData')}`); } catch {} }
      // 首次运行：优先选择 WSL/Ubuntu，其次 PowerShell（不提示安装）
      try { await ensureFirstRunTerminalSelection(); } catch {}
      try { await ensureSettingsAutodetect(); } catch {}
      try { await ensureAllCodexNotifications(); } catch {}
      if (DIAG) { try { perfLogger.log(`[BOOT] Locale: ${i18n.getCurrentLocale?.()}`); } catch {} }
      try { registerNotificationIPC(() => mainWindow, { appUserModelId, protocolScheme: PROTOCOL_SCHEME, profileId: instanceProfile.profileId }); } catch {}
      // 启动时静默检查更新由渲染进程完成（仅提示，不下载）
      try { setTermDebug(!!getDebugConfig().terminal.pty.debug); } catch {}
      // 启动历史索引器：后台并发解析、缓存、监听变更
      try { purgeHistoryCacheIfOutdated(); } catch {}
      try { await startHistoryIndexer(() => mainWindow); } catch (e) { console.warn('indexer start failed', e); }
      // 启动后立刻触发一次 UI 强制刷新，确保首次 ready 后显示索引内容
      try { mainWindow?.webContents.send('history:index:add', { items: [] }); } catch {}
      try { perfLogger.log(`[BOOT] background init done`); } catch {}
    })();
  });

  const tryStopIndexer = () => {
    try { stopHistoryIndexer().catch(() => {}); } catch {}
  };

  app.on('before-quit', (event) => {
    try {
      if (!quitConfirmed) {
        const count = ptyManager.getActiveSessionCount();
        if (count > 0) {
          event.preventDefault();
          if (quitConfirming) return;
          quitConfirming = true;
          const win = mainWindow;
          void (async () => {
            try {
              const ok = await confirmQuitWithActiveTerminals(win, count);
              if (!ok) return;
              quitConfirmed = true;
              try { app.quit(); } catch {}
            } finally {
              quitConfirming = false;
            }
          })();
          return;
        }
      }
    } catch {}
    disposeAllPtys();
    cleanupPastedImages().catch(() => {});
    disposeCodexBridges();
    try { unregisterNotificationIPC({ closeNotifications: true }); } catch {}
    // 主动关闭文件索引 watcher，避免退出阶段残留句柄
    try { (fileIndex as any).setActiveRoots?.([]); } catch {}
    tryStopIndexer();
    try { unwatchDebugConfig(); } catch {}
  });

  app.on('will-quit', () => {
    disposeAllPtys();
    cleanupPastedImages().catch(() => {});
    disposeCodexBridges();
    try { unregisterNotificationIPC({ closeNotifications: true }); } catch {}
    // 主动关闭文件索引 watcher，避免退出阶段残留句柄
    try { (fileIndex as any).setActiveRoots?.([]); } catch {}
    tryStopIndexer();
    try { unwatchDebugConfig(); } catch {}
  });

  // Also hook process-level events so that when Node receives termination signals we attempt cleanup.
  process.on('exit', () => { disposeAllPtys(); disposeCodexBridges(); try { unregisterNotificationIPC({ closeNotifications: true }); } catch {}; tryStopIndexer(); try { unwatchDebugConfig(); } catch {}; });
  process.on('SIGINT', () => { disposeAllPtys(); cleanupPastedImages().catch(() => {}); disposeCodexBridges(); try { unregisterNotificationIPC({ closeNotifications: true }); } catch {}; tryStopIndexer(); try { unwatchDebugConfig(); } catch {}; process.exit(0); });
  process.on('SIGTERM', () => { disposeAllPtys(); cleanupPastedImages().catch(() => {}); disposeCodexBridges(); try { unregisterNotificationIPC({ closeNotifications: true }); } catch {}; tryStopIndexer(); try { unwatchDebugConfig(); } catch {}; process.exit(0); });
  process.on('uncaughtException', (err) => {
    try { console.error('uncaughtException', err); } catch {}
    if (DIAG) { try { perfLogger.log(`[PROC] uncaughtException ${String((err as any)?.stack || err)}`); } catch {} }
    disposeAllPtys();
    disposeCodexBridges();
    try { unregisterNotificationIPC({ closeNotifications: true }); } catch {}
    try { unwatchDebugConfig(); } catch {}
    // 为避免再次被当前监听器拦截，移除所有 uncaughtException 监听后在下一轮事件循环抛出
    try { process.removeAllListeners('uncaughtException'); } catch {}
    try { setImmediate(() => { throw err; }); } catch {}
  });
  if (DIAG) process.on('unhandledRejection', (reason: any) => {
    try { perfLogger.log(`[PROC] unhandledRejection ${String((reason as any)?.stack || reason)}`); } catch {}
  });

  app.on('window-all-closed', () => {
    // On Windows & Linux, quit on all closed
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

// 应用菜单：显式提供 View -> Toggle Developer Tools，避免依赖平台默认菜单
function setupAppMenu() {
  try {
    const isMac = process.platform === 'darwin';
    const template: Electron.MenuItemConstructorOptions[] = [
      // macOS 标准应用菜单
      ...(isMac ? [{ role: 'appMenu' as const }] : []),
    ];
    // 打包版 Windows/Linux 不保留菜单栏；开发期或 macOS 仍保留调试入口
    if (!app.isPackaged || isMac) {
      template.push(
        {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            { type: 'separator' },
            { role: 'toggleDevTools', accelerator: isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I' },
          ],
        },
        {
          label: 'Window',
          submenu: [
            { role: 'minimize' },
            { role: 'close' },
          ],
        },
        {
          label: 'Help',
          submenu: [
            {
              label: 'Open Perf Log Folder',
              click: () => {
                try { shell.showItemInFolder(path.join(app.getPath('userData'), 'perf.log')); } catch {}
              },
            },
          ],
        },
      );
    }
    if (template.length === 0) {
      Menu.setApplicationMenu(null);
    } else {
      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    }
  } catch {}
}

// -------- IPC: PTY bridge (I/O only) --------
ipcMain.handle('pty:open', async (_event, args: {
  terminal?: 'wsl' | 'windows' | 'pwsh'; distro?: string; wslPath?: string; winPath?: string; cols?: number; rows?: number; startupCmd?: string;
}) => {
  const id = ptyManager.openWSLConsole({
    terminal: args?.terminal as any,
    distro: args?.distro,
    wslPath: args?.wslPath,
    winPath: args?.winPath,
    cols: args?.cols ?? 80,
    rows: args?.rows ?? 24,
    startupCmd: args?.startupCmd ?? ''
  });
  return { id };
});

ipcMain.on('pty:write', (_e, { id, data }: { id: string; data: string }) => {
  ptyManager.write(id, data);
});

ipcMain.on('pty:resize', (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
  ptyManager.resize(id, cols, rows);
});

ipcMain.on('pty:close', (_e, { id }: { id: string }) => {
  ptyManager.close(id);
});

// 可选：在 resize 期间暂停/恢复数据流，以及与 ConPTY 同步清屏
ipcMain.on('pty:pause', (_e, { id }: { id: string }) => {
  try { ptyManager.pause(id); } catch {}
});
ipcMain.on('pty:resume', (_e, { id }: { id: string }) => {
  try { ptyManager.resume(id); } catch {}
});
ipcMain.on('pty:clear', (_e, { id }: { id: string }) => {
  try { ptyManager.clear(id); } catch {}
});

// File Index API（Windows 侧枚举，结果缓存于内存+磁盘）
ipcMain.handle('fileIndex.ensure', async (_e, { root, excludes }: { root: string; excludes?: string[] }) => {
  try {
    const res = await fileIndex.ensureIndex({ root, excludes });
    return { ok: true, total: res.total, updatedAt: res.updatedAt };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

// 打开外部控制台（根据设置选择 WSL 或 Windows 终端）
ipcMain.handle('utils.openExternalConsole', async (_e, args: { terminal?: 'wsl' | 'windows' | 'pwsh'; wslPath?: string; winPath?: string; distro?: string; startupCmd?: string; title?: string }) => {
  try {
    const platform = process.platform;
    const cfg = settings.getSettings();
    const terminal = (args as any)?.terminal || cfg.terminal || 'wsl';
    const startupCmd = String(args?.startupCmd || cfg.codexCmd || 'codex');
    const requestedDistro = String(args?.distro || cfg.distro || 'Ubuntu-24.04');
    const title = String((args as any)?.title || '').trim() || 'Codex';

    const extLog = (msg: string) => {
      // 默认关闭：仅在 debug.config.jsonc 启用 global.diagLog 时记录
      if (!DIAG) return;
      try { perfLogger.log(msg); } catch {}
    };
    try {
      const rawWin = String(args?.winPath ?? '');
      const rawWsl = String(args?.wslPath ?? '');
      extLog(`[external] openExternalConsole req platform=${platform} terminal=${terminal} distro=${requestedDistro} title=${title} winPath='${rawWin}' wslPath='${rawWsl}' startupLen=${startupCmd.length}`);
    } catch {}

    const guardKey = [
      platform,
      terminal,
      requestedDistro,
      String(args?.wslPath || ''),
      String(args?.winPath || ''),
      title,
      startupCmd,
    ].join("|");
    if (shouldSkipExternalConsoleLaunch(guardKey)) return { ok: true, skipped: true } as const;

    if (platform === 'win32' && (terminal === 'windows' || terminal === 'pwsh')) {
      // 计算工作目录：优先使用 winPath，其次从 wslPath 推导
      let cwd = String(args?.winPath || '').trim();
      const wslPathRaw = String(args?.wslPath || '').trim();
      if (!cwd && wslPathRaw) {
        const m = wslPathRaw.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
        if (m) cwd = `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
        if (!cwd) { try { cwd = wsl.wslToUNC(wslPathRaw, requestedDistro); } catch {} }
      }
      try { cwd = wsl.normalizeWinPath(cwd); } catch {}
      if (!cwd) { try { cwd = require('node:os').homedir(); } catch { cwd = process.cwd(); } }
      extLog(`[external] windows-shell cwd='${cwd}'`);

      // 优先 Windows Terminal
      const resolvedShell = resolveWindowsShell(terminal === 'pwsh' ? 'pwsh' : 'windows');
      // PowerShell 字符串经常包含引号与分号；为彻底避免转义问题，改用 -EncodedCommand（UTF-16LE -> Base64）
      const toPsEncoded = (s: string) => Buffer.from(s, 'utf16le').toString('base64');
      // 使用 Windows Terminal：指定起始目录，由 WT 负责切换目录；PowerShell 仅执行命令
      // 必须加入 `--`，将后续命令行完整传入新标签，而不被 wt 解析
      // 打包版从资源管理器启动时没有父控制台，需要显式禁用 windowsHide 确保 WT 窗口可见
      const wtArgs = ['-w', '0', 'new-tab', '--title', title, '--startingDirectory', cwd, '--', resolvedShell.command, '-NoExit', '-NoProfile', '-EncodedCommand', toPsEncoded(startupCmd)];
      {
        const ok = await spawnDetachedSafe('wt.exe', wtArgs, WT_VISIBLE_SPAWN_OPTS);
        extLog(`[external] launch wt.exe ok=${ok ? 1 : 0}`);
        if (ok) return { ok: true } as const;
      }
      {
        const ok = await spawnDetachedSafe('WindowsTerminal.exe', wtArgs, WT_VISIBLE_SPAWN_OPTS);
        extLog(`[external] launch WindowsTerminal.exe ok=${ok ? 1 : 0}`);
        if (ok) return { ok: true } as const;
      }
      // 回退：cmd /c start 一个 PowerShell 窗口，使用 -EncodedCommand，先切换目录再执行
      const psScript = `Set-Location -Path \"${cwd.replace(/"/g, '\\"')}\"; ${startupCmd}`;
      const psEncoded = toPsEncoded(psScript);
      // 注意：cmd 的 start 需要显式传入“窗口标题”参数；最稳妥的方式是传空标题 `""`，避免把第一个参数当作命令执行。
      // 例如：start Codex wsl.exe ... 会错误地执行 codex，并把后续参数（含 -d）传给 codex。
      {
        const cmdExe = resolveSystemBinary('cmd.exe');
        const ok = await spawnDetachedSafe(cmdExe, ['/c', 'start', '', resolvedShell.command, '-NoExit', '-NoProfile', '-EncodedCommand', psEncoded], { windowsHide: false });
        extLog(`[external] launch cmd.exe(start ${resolvedShell.command}) ok=${ok ? 1 : 0}`);
        if (ok) return { ok: true } as const;
      }
      return { ok: false, error: 'failed to launch external Windows console' } as const;
    }

    // 否则：WSL 路径与逻辑（优先使用 wsl.exe --cd，参考“新建代理”的定位策略）
    let wslCwd = "";
    let wslCwdSource = "";
    const rawWinPath = String(args?.winPath || "").trim().replace(/\\n/g, "").replace(/\r?\n/g, "").replace(/^"|"$/g, "").trim();
    const rawWslPath = String(args?.wslPath || "").trim().replace(/\\n/g, "").replace(/\r?\n/g, "").replace(/^"|"$/g, "").trim();
    const normalizedWinPath = platform === "win32" ? wsl.normalizeWinPath(rawWinPath) : rawWinPath;
    const normalizedWslWinLike = (platform === "win32" && rawWslPath && !rawWslPath.startsWith("/")) ? wsl.normalizeWinPath(rawWslPath) : rawWslPath;

    if (rawWslPath && rawWslPath.startsWith("/")) {
      wslCwd = rawWslPath;
      wslCwdSource = "args.wslPath(posix)";
    } else if (rawWslPath === "~") {
      wslCwd = "~";
      wslCwdSource = "args.wslPath(~)";
    } else if (platform === "win32") {
      // 兼容：wslPath 误填入 Windows/UNC/PowerShell 路径
      try {
        const fromWslArg = rawWslPath ? wsl.winToWsl(normalizedWslWinLike, requestedDistro) : "";
        if (fromWslArg && fromWslArg.startsWith("/")) {
          wslCwd = fromWslArg;
          wslCwdSource = "args.wslPath(winToWsl)";
        }
      } catch {}
      if (!wslCwd && normalizedWinPath) {
        try {
          const fromWinArg = wsl.winToWsl(normalizedWinPath, requestedDistro);
          if (fromWinArg && fromWinArg.startsWith("/")) {
            wslCwd = fromWinArg;
            wslCwdSource = "args.winPath(winToWsl)";
          }
        } catch {}
      }
    } else {
      // 非 Windows：保持原样（主要用于开发调试）
      if (rawWslPath) { wslCwd = rawWslPath; wslCwdSource = "args.wslPath(raw)"; }
      else if (normalizedWinPath) { wslCwd = normalizedWinPath; wslCwdSource = "args.winPath(raw)"; }
    }
    if (!wslCwd) { wslCwd = "~"; wslCwdSource = "fallback(~)"; }

    // 注意：避免在这里拼接 `;`，否则 Windows Terminal `wt.exe` 可能把 `;` 当作命令分隔符解析。
    // 同时：即使 `--cd` 未生效，也要通过 bash 内部再次 `cd`，避免落在应用工作目录。
    const esc = (s: string) => String(s || "").replace(/\"/g, '\\\"');
    const cdCmd = (wslCwd && wslCwd !== '~') ? `cd \"${esc(wslCwd)}\" 2>/dev/null || cd ~` : 'cd ~';
    // 关键：不要把 cd 放在 `(...)` 子 shell 中，否则目录切换不会影响后续命令
    // 使用换行分隔命令，避免引入 `;`（Windows Terminal 可能把 `;` 当作分隔符解析）
    const bashScript = `${cdCmd}\n${startupCmd}\nexec bash`;
    extLog(`[external] wsl-shell cwd='${wslCwd}' source=${wslCwdSource}`);

    if (platform === 'win32') {
      const hasDistro = (() => { try { return wsl.distroExists(requestedDistro); } catch { return false; } })();
      const distroArgv = hasDistro ? ['-d', requestedDistro] as string[] : [];
      const canUseWt = !bashScript.includes(';');
      // 若 Windows 侧目录不存在，则不传 --cd，避免 WSL 输出 chdir failed 噪声；目录切换由 bashScript 兜底
      const shouldUseCdArgv = (() => {
        try {
          if (!wslCwd || wslCwd === '~') return false;
          if (!normalizedWinPath) return true; // 无法校验，保守传入
          // 仅对盘符路径做存在性校验
          if (!/^[A-Za-z]:\\/.test(normalizedWinPath)) return true;
          return fs.existsSync(normalizedWinPath);
        } catch {
          return true;
        }
      })();
      const cdArgv = shouldUseCdArgv ? ['--cd', wslCwd] as string[] : [];
      const wslExe = resolveSystemBinary('wsl.exe');
      // 同理：禁用 windowsHide，避免 WT 在 GUI 场景下被隐藏
      const wtArgs = ['-w', '0', 'new-tab', '--title', title, '--', wslExe, ...distroArgv, ...cdArgv, '--', 'bash', '-lic', bashScript];
      if (canUseWt) {
        {
          const ok = await spawnDetachedSafe('wt.exe', wtArgs, WT_VISIBLE_SPAWN_OPTS);
          extLog(`[external] launch wt.exe(wsl) ok=${ok ? 1 : 0}`);
          if (ok) return { ok: true } as const;
        }
        {
          const ok = await spawnDetachedSafe('WindowsTerminal.exe', wtArgs, WT_VISIBLE_SPAWN_OPTS);
          extLog(`[external] launch WindowsTerminal.exe(wsl) ok=${ok ? 1 : 0}`);
          if (ok) return { ok: true } as const;
        }
      }
      const psArgListParts = [
        ...(hasDistro ? [`'-d'`, `'${requestedDistro.replace(/'/g, "''")}'`] : []),
        ...(wslCwd && wslCwd !== "~" ? [`'--cd'`, `'${wslCwd.replace(/'/g, "''")}'`] : []),
        `'--'`,
        `'bash'`,
        `'-lic'`,
        `'${bashScript.replace(/'/g, "''")}'`
      ];
      const wslExePs = wslExe.replace(/'/g, "''");
      const psCmd = `Start-Process -FilePath '${wslExePs}' -ArgumentList @(${psArgListParts.join(',')}) -WindowStyle Normal`;
      {
        const powershellExe = resolveSystemBinary('powershell.exe');
        const ok = await spawnDetachedSafe(powershellExe, ['-NoProfile', '-NonInteractive', '-Command', psCmd], { windowsHide: false });
        extLog(`[external] launch powershell.exe(Start-Process wsl) ok=${ok ? 1 : 0}`);
        if (ok) return { ok: true } as const;
      }
      // cmd start 同样需要显式传入空标题 `""`，避免把第一个参数当作命令执行
      {
        const cmdExe = resolveSystemBinary('cmd.exe');
        const ok = await spawnDetachedSafe(cmdExe, ['/c', 'start', '', wslExe, ...distroArgv, ...(wslCwd && wslCwd !== '~' ? ['--cd', wslCwd] : []), '--', 'bash', '-lic', bashScript], { windowsHide: false });
        extLog(`[external] launch cmd.exe(start wsl.exe) ok=${ok ? 1 : 0}`);
        if (ok) return { ok: true } as const;
      }
      return { ok: false, error: 'failed to launch external WSL console' } as const;
    }

    const candidates: Array<{ cmd: string; args: string[] }> = [
      { cmd: 'x-terminal-emulator', args: ['-e', 'bash', '-lc', bashScript] },
      { cmd: 'gnome-terminal', args: ['--', 'bash', '-lc', bashScript] },
      { cmd: 'konsole', args: ['-e', 'bash', '-lc', bashScript] },
      { cmd: 'xterm', args: ['-e', 'bash', '-lc', bashScript] },
    ];
    for (const c of candidates) {
      try { const child = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', cwd: process.env.HOME }); child.on('error', () => {}); child.unref(); return { ok: true } as const; } catch {}
    }
    return { ok: false, error: 'no terminal available' } as const;
  } catch (e: any) {
    return { ok: false, error: String(e) } as const;
  }
});
ipcMain.handle('fileIndex.candidates', async (_e, { root }: { root: string }) => {
  try {
    const items = fileIndex.getAllCandidates(root);
    return { ok: true, items };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('fileIndex.activeRoots', async (event, { roots }: { roots: string[] }) => {
  try {
    const list = Array.isArray(roots) ? roots.filter((x) => typeof x === 'string') : [];
    const senderId = (event as any)?.sender?.id;
    if (typeof senderId !== 'number') {
      const res = (fileIndex as any).setActiveRoots ? (fileIndex as any).setActiveRoots(list) : { closed: 0, remain: 0, trimmed: 0 };
      return { ok: true, ...res };
    }

    // 记录当前窗口的活跃根集合，并在窗口销毁时自动移除，避免跨窗口互相“清空” watcher
    activeRootsBySender.set(senderId, new Set(list));
    if (!activeRootsSenderHooked.has(senderId)) {
      activeRootsSenderHooked.add(senderId);
      try {
        (event as any)?.sender?.once?.('destroyed', () => {
          activeRootsBySender.delete(senderId);
          activeRootsSenderHooked.delete(senderId);
          try { applyMergedActiveRoots(); } catch {}
        });
      } catch {}
    }

    const res = applyMergedActiveRoots();
    return { ok: true, ...res };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

// Projects API
/** 快速读取项目缓存列表（不触发扫描） */
ipcMain.handle('projects.list', async () => {
  try {
    const res = projects.listProjectsFromStore();
    return { ok: true, projects: res };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('projects.scan', async (_e, { roots }: { roots?: string[] }) => {
  try {
    const res = await projects.scanProjectsAsync(roots, true);
    return { ok: true, projects: res };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('projects.add', async (_e, { winPath }: { winPath: string }) => {
  try {
    const p = projects.addProjectByWinPath(winPath);
    return { ok: true, project: p };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.on('projects.touch', (_e, { id }: { id: string }) => {
  projects.touchProject(id);
});

// History API
ipcMain.handle('history.list', async (_e, args: { projectWslPath?: string; projectWinPath?: string; limit?: number; offset?: number; historyRoot?: string }) => {
  try {
    // 尝试优先使用索引器（不阻塞 UI）
    const canon = (p?: string): string => {
      if (!p) return '';
      try {
        let s = String(p).replace(/\\n/g, '').replace(/\\\\+/g, '\\').replace(/^"|"$/g, '');
        if (/^\\\\wsl\.localhost\\/i.test(s)) {
          // UNC -> WSL
          const info = require('./wsl').uncToWsl(s);
          if (info) return info.wslPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        }
        const m = s.match(/^([a-zA-Z]):\\(.*)$/);
        if (m) return (`/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`).replace(/\/+$/, '').toLowerCase();
        return s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      } catch { return String(p || '').toLowerCase(); }
    };
    const needles = Array.from(new Set([canon(args.projectWslPath), canon(args.projectWinPath)].filter(Boolean)));

    /**
     * 兼容 Gemini 的 projectHash：部分会话缺失 cwd 时，需用项目路径反推 hash 来做归属过滤。
     */
    const geminiHashNeedles = new Set<string>();
    const deriveWslFromWinPath = (p?: string): string => {
      try {
        const s = String(p || '').trim();
        if (!s) return '';
        const m = s.match(/^([a-zA-Z]):\\(.*)$/);
        if (!m) return '';
        return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
      } catch {
        return '';
      }
    };
    const addGeminiHashCandidate = (p?: string) => {
      try {
        const raw = typeof p === 'string' ? p.trim() : '';
        if (!raw) return;
        const h1 = sha256Hex(normalizeGeminiPathForHash(raw));
        const h2 = sha256Hex(tidyPathCandidate(raw));
        if (h1) geminiHashNeedles.add(h1);
        if (h2) geminiHashNeedles.add(h2);
      } catch {}
    };
    addGeminiHashCandidate(args.projectWslPath);
    addGeminiHashCandidate(args.projectWinPath);
    addGeminiHashCandidate(deriveWslFromWinPath(args.projectWinPath));
    const all = getIndexedSummaries();
    // Minimal probe logging (opt-in): only when CODEX_HISTORY_DEBUG=1
    const dbg = () => { try { return !!getDebugConfig().history.debug; } catch { return false; } };
    const dbgFile = (() => { try { return String(getDebugConfig().history.filter || '').trim().toLowerCase(); } catch { return ''; } })();
    if (all && all.length > 0) {
      const startsWithBoundary = (child: string, parent: string): boolean => {
        try {
          const c = String(child || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
          const p = String(parent || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
          if (!c || !p) return false;
          if (c === p) return true;
          return c.startsWith(p + '/');
        } catch { return false; }
      };
      const filtered = needles.length === 0
        ? all
        : all.filter((s) => {
            if (needles.some((n) => startsWithBoundary(s.dirKey, n))) return true;
            if (s.providerId === 'gemini' && geminiHashNeedles.size > 0) {
              const h = extractGeminiProjectHashFromPath(String(s.filePath || ''));
              if (h && geminiHashNeedles.has(h)) return true;
            }
            return false;
          });
      try {
        if (dbg()) {
          const foundIdx = dbgFile ? all.some((x: any) => String(x.filePath || '').toLowerCase().includes(dbgFile)) : false;
          const foundFiltered = dbgFile ? filtered.some((x: any) => String(x.filePath || '').toLowerCase().includes(dbgFile)) : false;
          perfLogger.log(`[history:list:probe] needles=${JSON.stringify(needles)} all=${all.length} filtered=${filtered.length} foundIdx=${foundIdx} foundFiltered=${foundFiltered}`);
        }
      } catch {}
      // 若索引器有数据但按 dirKey 过滤后为空，针对指定项目路径回退到更稳妥的读取逻辑（全文前缀/启发式匹配）
      if (needles.length > 0 && filtered.length === 0) {
        try {
          const prefRoot = typeof args.historyRoot === 'string' && args.historyRoot.trim().length > 0 ? args.historyRoot : settings.getSettings().historyRoot;
          const res = await perfLogger.time('history.list.fallbackWhenEmpty', () => history.listHistory({ wslPath: args.projectWslPath, winPath: args.projectWinPath }, { limit: args.limit, offset: args.offset, historyRoot: prefRoot }));
          return { ok: true, sessions: res };
        } catch {}
      }
      const sorted = filtered.sort((a, b) => b.date - a.date);
      const offset = Math.max(0, Number(args.offset || 0));
      const end = args.limit ? offset + Number(args.limit) : undefined;
      const sliced = sorted.slice(offset, end);
      const mapped = sliced.map((x) => ({
        providerId: (x as any).providerId || "codex",
        id: x.id,
        title: x.title,
        date: x.date,
        filePath: x.filePath,
        rawDate: x.rawDate,
        preview: (x as any).preview,
        resumeMode: (x as any).resumeMode,
        resumeId: (x as any).resumeId,
        runtimeShell: (x as any).runtimeShell,
      }));
      return { ok: true, sessions: mapped };
    }
    // 索引器未就绪时，回退到旧逻辑
    const prefRoot = typeof args.historyRoot === 'string' && args.historyRoot.trim().length > 0 ? args.historyRoot : settings.getSettings().historyRoot;
    const res = await perfLogger.time('history.list.fallback', () => history.listHistory({ wslPath: args.projectWslPath, winPath: args.projectWinPath }, { limit: args.limit, offset: args.offset, historyRoot: prefRoot }));
    return { ok: true, sessions: res };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('history.read', async (_e, args: { filePath: string; providerId?: string }) => {
  const filePath = String(args?.filePath || '');
  const providerHint = String(args?.providerId || '').trim().toLowerCase();
  try {
    const cached = getCachedDetails(filePath);
    if (cached) return cached;
  } catch {}
  try {
    const det = getIndexedDetails(filePath);
    if (det) {
      try { cacheDetails(filePath, det); } catch {}
      return det;
    }
  } catch {}

  const inferProviderId = (): "codex" | "claude" | "gemini" => {
    const hint = providerHint;
    if (hint === 'codex' || hint === 'claude' || hint === 'gemini') return hint as any;
    try {
      const found = getIndexedSummaries().find((s: any) => String(s?.filePath || '') === filePath);
      const pid = String((found as any)?.providerId || '').trim().toLowerCase();
      if (pid === 'codex' || pid === 'claude' || pid === 'gemini') return pid as any;
    } catch {}
    try {
      const fp = filePath.replace(/\\/g, '/').toLowerCase();
      const base = fp.split('/').pop() || '';
      if (fp.includes('/.claude/')) return 'claude';
      if (fp.includes('/.gemini/')) return 'gemini';
      if (base.endsWith('.ndjson')) return 'claude';
      if (base.startsWith('session-') && base.endsWith('.json')) return 'gemini';
    } catch {}
    return 'codex';
  };

  const providerId = inferProviderId();

  if (providerId === "claude") {
    const stat = await fsp.stat(filePath);
    const parsed = await parseClaudeSessionFile(filePath, stat, { summaryOnly: false, maxLines: 50_000 });
    try { cacheDetails(filePath, parsed as any); } catch {}
    return parsed as any;
  }
  if (providerId === "gemini") {
    const stat = await fsp.stat(filePath);
    const parsed = await parseGeminiSessionFile(filePath, stat, { summaryOnly: false, maxBytes: 64 * 1024 * 1024 });
    try { cacheDetails(filePath, parsed as any); } catch {}
    return parsed as any;
  }

  const parsed = await history.readHistoryFile(filePath);
  const withMeta = { ...(parsed as any), providerId: "codex", filePath };
  try { cacheDetails(filePath, withMeta as any); } catch {}
  return withMeta;
});

// 扫描所有索引的会话，找出“有效输入/输出均为空”的文件（安全优先：解析失败不纳入可清理候选）
ipcMain.handle('history.findEmptySessions', async () => {
  try {
    const sums = getIndexedSummaries();
    const candidates: { id: string; title: string; rawDate?: string; date: number; filePath: string; sizeKB?: number }[] = [];
    const MAX_CANDIDATES = 200;
    const SAFE_MAX_BYTES = 64 * 1024 * 1024; // 保护：避免对极端大文件做“判空”

    /**
     * 构建用于 fs 操作的路径候选（兼容 Windows/WSL 路径互转）。
     */
    const buildFsPathCandidates = (filePath: string): string[] => {
      const list: string[] = [];
      const push = (p?: string) => { if (p && !list.includes(p)) list.push(p); };
      const p0 = String(filePath || "");
      const normSlashes = (p: string) => (process.platform === "win32" ? p.replace(/\//g, "\\") : p);
      if (process.platform === "win32") {
        // Windows 下：优先把 POSIX(/home|/mnt) 转为可访问的 UNC/盘符路径
        if (/^\//.test(p0)) {
          try { push(wsl.wslToUNC(p0, settings.getSettings().distro || "Ubuntu-24.04")); } catch {}
          const m = p0.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
          if (m) push(`${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`);
        }
      }
      push(normSlashes(p0));
      return list;
    };

    /**
     * 推断 providerId（优先使用索引字段，其次按路径特征兜底）。
     */
    const inferProviderId = (summary: any, filePath: string): "codex" | "claude" | "gemini" => {
      const hinted = String(summary?.providerId || "").trim().toLowerCase();
      if (hinted === "codex" || hinted === "claude" || hinted === "gemini") return hinted as any;
      try {
        const fp = String(filePath || "").replace(/\\/g, "/").toLowerCase();
        const base = fp.split("/").pop() || "";
        if (fp.includes("/.claude/")) return "claude";
        if (fp.includes("/.gemini/")) return "gemini";
        if (base.endsWith(".ndjson")) return "claude";
        if (base.startsWith("session-") && base.endsWith(".json")) return "gemini";
      } catch {}
      return "codex";
    };

    for (const s of (sums || [])) {
      if (candidates.length >= MAX_CANDIDATES) break;
      try {
        const filePath = String((s as any)?.filePath || "");
        if (!filePath) continue;

        // 优先使用索引阶段生成的 preview：有 preview 说明至少存在有效用户输入
        const preview = typeof (s as any)?.preview === "string" ? String((s as any).preview).trim() : "";
        if (preview) continue;

        let title = String((s as any).title || "");
        let rawDate = (s as any).rawDate ? String((s as any).rawDate) : undefined;
        let date = Number((s as any).date || 0);
        let id = String((s as any).id || "");
        const providerId = inferProviderId(s, filePath);

        // 解析/判空前，先解析出可访问路径与文件大小；文件不存在则跳过（避免把“不存在”误判为“空”）
        const statCandidates = buildFsPathCandidates(filePath);
        let resolvedPath: string | null = null;
        let st: fs.Stats | null = null;
        for (const cand of statCandidates) {
          try {
            if (fs.existsSync(cand)) {
              resolvedPath = cand;
              st = fs.statSync(cand);
              break;
            }
          } catch {}
        }
        if (!resolvedPath || !st) continue;

        const sizeBytes = Number((st as any)?.size ?? 0);
        const sizeKB = Math.max(0, Math.round(sizeBytes / 1024));
        if (sizeBytes === 0) {
          candidates.push({ id, title, rawDate, date, filePath, sizeKB } as any);
          continue;
        }
        // 超大文件默认不判空（安全优先 + 性能保护）
        if (sizeBytes > SAFE_MAX_BYTES) continue;

        let messages: any[] = [];
        let skippedLines = 0;
        let parsed: any = null;
        try {
          if (providerId === "claude") {
            parsed = await parseClaudeSessionFile(resolvedPath, st, { summaryOnly: false, maxLines: 8000 });
          } else if (providerId === "gemini") {
            parsed = await parseGeminiSessionFile(resolvedPath, st, { summaryOnly: false, maxBytes: SAFE_MAX_BYTES });
          } else {
            parsed = await history.readHistoryFile(resolvedPath, { maxLines: 80_000 });
          }
          messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
          skippedLines = Number(parsed?.skippedLines || 0);
          // 仅用于展示：尽量补齐缺失的摘要字段
          if (!title && parsed?.title) title = String(parsed.title);
          if (!rawDate && parsed?.rawDate) rawDate = String(parsed.rawDate);
          if (!date && parsed?.date) date = Number(parsed.date);
          if (!id && parsed?.id) id = String(parsed.id);
        } catch {
          // 解析失败：为安全起见，不纳入“可清理”候选（避免误删非空历史）
          continue;
        }

        const hasNonEmptyIO = hasNonEmptyIOFromMessages(messages);
        if (hasNonEmptyIO) continue;

        // Claude parser 在超过 maxLines 时会累计 skippedLines：此时无法保证后续不存在有效内容，避免误删。
        if (providerId === "claude" && skippedLines > 0) continue;
        // Codex：若文件明显不小，避免仅凭前若干行就判空（安全优先）
        if (providerId === "codex" && sizeBytes > 256 * 1024) continue;

        candidates.push({ id, title, rawDate, date, filePath, sizeKB } as any);
      } catch {}
    }
    return { ok: true, candidates } as any;
  } catch (e: any) {
    return { ok: false, error: String(e) } as any;
  }
});

// 批量彻底删除（逐个尝试）
ipcMain.handle('history.trashMany', async (_e, { filePaths }: { filePaths: string[] }) => {
  try {
    const results: { filePath: string; ok: boolean; notFound?: boolean; error?: string }[] = [];
    let okCount = 0; let notFoundCount = 0; let failCount = 0;
    const list = Array.isArray(filePaths) ? filePaths.slice() : [];
    // 并发限制器：避免一次性对大量文件触发过多 I/O / shell 调用
    const pLimitLocal = (max: number) => {
      let running = 0; const q: (() => void)[] = [];
      const next = () => { running--; const fn = q.shift(); if (fn) fn(); };
      return function <T>(task: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
          const run = () => {
            running++;
            task().then((v) => { next(); resolve(v); }).catch((e) => { next(); reject(e); });
          };
          if (running < max) run(); else q.push(run);
        });
      };
    };
    const limit = pLimitLocal(6);

    // 单个文件删除逻辑（保持原候选顺序）：彻底删除
    const handleOne = async (filePath: string) => {
      if (!filePath || typeof filePath !== 'string') return { filePath: String(filePath), ok: false, error: 'invalid filePath' };
      const candidates: string[] = [];
      const push = (p?: string) => { if (p && !candidates.includes(p)) candidates.push(p); };
      const normSlashes = (p: string) => (process.platform === 'win32' ? p.replace(/\//g, '\\') : p);
      const p0 = String(filePath);
      if (process.platform === 'win32') {
        if (/^\//.test(p0)) {
          try { push(wsl.wslToUNC(p0, settings.getSettings().distro || 'Ubuntu-24.04')); } catch {}
          const m = p0.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
          if (m) push(`${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`);
        }
      }
      push(normSlashes(p0));
      const anyExists = candidates.some((c) => { try { return fs.existsSync(c); } catch { return false; } });
      if (!anyExists) return { filePath: p0, ok: true, notFound: true };
      let deleted = false; const failed: { cand: string; err: any }[] = [];
      for (const cand of candidates) {
        try {
          if (!fs.existsSync(cand)) { failed.push({ cand, err: 'not_exists' }); continue; }
          try {
            await fsp.rm(cand, { force: true });
            try { const idx = require('./indexer'); if (typeof idx.removeFromIndex === 'function') idx.removeFromIndex(cand); } catch {}
            try { const hist = require('./history').default; await hist.removePathFromCache(cand); } catch {}
            try { const win = BrowserWindow.getFocusedWindow(); win?.webContents.send('history:index:remove', { filePath: cand }); } catch {}
            deleted = true; break;
          } catch (e1: any) {
            failed.push({ cand, err: e1 });
          }
        } catch (e: any) { failed.push({ cand, err: e }); }
      }
      if (deleted) return { filePath: p0, ok: true };
      try {
        const hist = require('./history').default; try { await hist.removePathFromCache(p0); } catch {}
        const idx = require('./indexer'); try { if (typeof idx.removeFromIndex === 'function') idx.removeFromIndex(p0); } catch {}
      } catch {}
      const details = failed.map(f => `${f.cand}: ${String(f.err)}`).join('; ');
      return { filePath: p0, ok: false, error: `Failed to delete permanently (${details})` };
    };

    // 并发执行（限制并发数），收集结果
    const tasks = list.map((fp) => limit(() => handleOne(fp).catch((e) => ({ filePath: String(fp), ok: false, error: String(e) }))));
    const resArr = await Promise.all(tasks);
    for (const r of resArr) {
      results.push(r as any);
      if (r.ok) {
        // r 的具体类型可能不包含 notFound（例如已成功删除），
        // 因此显式检测属性存在性以满足 TypeScript 的类型检查。
        if ((r as any).notFound) notFoundCount++; else okCount++;
      } else failCount++;
    }

    return { ok: true, results, summary: { ok: okCount, notFound: notFoundCount, failed: failCount } } as any;
  } catch (e: any) {
    return { ok: false, error: String(e) } as any;
  }
});

// 彻底删除指定历史文件（支持 WSL/UNC/Windows 路径候选）
ipcMain.handle('history.trash', async (_e, { filePath }: { filePath: string }) => {
  try {
    if (!filePath || typeof filePath !== 'string') throw new Error('invalid filePath');
    const candidates: string[] = [];
    const push = (p?: string) => { if (p && !candidates.includes(p)) candidates.push(p); };
    const normSlashes = (p: string) => (process.platform === 'win32' ? p.replace(/\//g, '\\') : p);
    const p0 = String(filePath);
    // Windows 下候选顺序：
    // 1) POSIX -> UNC（跨发行版路径）
    // 2) /mnt/<drive> -> X:\ 盘符路径
    // 3) 原始路径
    if (process.platform === 'win32') {
      if (/^\//.test(p0)) {
        try { push(wsl.wslToUNC(p0, settings.getSettings().distro || 'Ubuntu-24.04')); } catch {}
        const m = p0.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
        if (m) push(`${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`);
      }
    }
    push(normSlashes(p0));
    // 候选均不存在则视为成功（无需删除）
    const anyExists = candidates.some((c) => { try { return fs.existsSync(c); } catch { return false; } });
    if (!anyExists) return { ok: true, notFound: true } as any;
    // 依次尝试候选：永久删除
    const failed: { cand: string; err: any }[] = [];
    for (const cand of candidates) {
      try {
        if (!fs.existsSync(cand)) { failed.push({ cand, err: 'not_exists' }); continue; }
        try {
          await fsp.rm(cand, { force: true });
          // 删除成功：同步清理索引与历史缓存，并通知渲染进程移除该项
          try { const idx = require('./indexer'); if (typeof idx.removeFromIndex === 'function') idx.removeFromIndex(cand); } catch {}
          try { const hist = require('./history').default; await hist.removePathFromCache(cand); } catch {}
          try { const win = BrowserWindow.getFocusedWindow(); win?.webContents.send('history:index:remove', { filePath: cand }); } catch {}
          return { ok: true };
        } catch (e1: any) {
          failed.push({ cand, err: e1 });
        }
      } catch (e: any) {
        failed.push({ cand, err: e });
      }
    }
    const details = failed.map(f => `${f.cand}: ${String(f.err)}`).join('; ');
    // 若删除失败，仍尝试从索引与历史缓存中移除该路径，避免切换项目后缓存恢复已删除会话
    try {
      const hist = require('./history').default;
      try { await hist.removePathFromCache(filePath); } catch {}
    } catch {}
    try {
      const idx = require('./indexer');
      try { if (typeof idx.removeFromIndex === 'function') idx.removeFromIndex(filePath); } catch {}
    } catch {}
    throw new Error(`Failed to delete permanently (${details})`);
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

// (trimmed) removed unused history.roots/listSplit/debugInfo handlers

// Utils: clipboard + save-as
ipcMain.handle('utils.copyText', async (_e, { text }: { text: string }) => {
  try { clipboard.writeText(String(text ?? '')); return { ok: true }; } catch (e: any) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('utils.readText', async () => {
  try {
    const text = clipboard.readText();
    return { ok: true, text };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('utils.perfLog', async (_e, { text }: { text: string }) => {
  try { perfLogger.log(`[renderer] ${String(text ?? '')}`); return { ok: true }; } catch (e: any) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('utils.fetchJson', async (_e, { url, timeoutMs, headers }: { url: string; timeoutMs?: number; headers?: Record<string, string> }) => {
  try {
    if (!url || typeof url !== 'string') throw new Error('invalid url');
    const controller = new AbortController();
    const maxTimeout = Math.max(1000, Number(timeoutMs ?? 10000));
    const timer = setTimeout(() => controller.abort(), maxTimeout);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(headers || {})
        },
        redirect: 'follow'
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) {
        return { ok: false, status: res.status, error: `HTTP ${res.status}`, raw: text };
      }
      let data: any;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch (e: any) {
        return { ok: false, status: res.status, error: `invalid_json: ${String(e?.message || e)}`, raw: text };
      }
      return { ok: true, status: res.status, data };
    } catch (err: any) {
      clearTimeout(timer);
      return { ok: false, error: String(err?.message || err) };
    }
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('utils.saveText', async (_e, { content, defaultPath }: { content: string; defaultPath?: string }) => {
  try {
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      defaultPath: defaultPath || 'history.txt',
      filters: [ { name: 'Text', extensions: ['txt'] }, { name: 'JSON', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] } ]
    } as any;
    const ret = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (ret.canceled || !ret.filePath) return { ok: false, canceled: true };
    const fs = await import('node:fs/promises');
    await fs.writeFile(ret.filePath, String(content ?? ''), 'utf8');
    return { ok: true, path: ret.filePath };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('utils.showInFolder', async (_e, { path: p }: { path: string }) => {
  try {
    if (!p || typeof p !== 'string') throw new Error('invalid path');
    const candidates: string[] = [];
    const push = (x?: string) => { if (x && !candidates.includes(x)) candidates.push(x); };
    const normSlashes = (s: string) => (process.platform === 'win32' ? s.replace(/\//g, '\\') : s);
    const raw = String(p);
    push(normSlashes(raw));
    if (process.platform === 'win32') {
      const m = raw.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
      if (m) push(`${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`);
      if (/^\//.test(raw)) {
        try { const unc = wsl.wslToUNC(raw, settings.getSettings().distro || 'Ubuntu-24.04'); push(unc); } catch {}
      }
    }
    // Try showItemInFolder for first existing file; else open containing directory
    for (const cand of candidates) {
      try {
        if (fs.existsSync(cand)) {
          shell.showItemInFolder(cand);
          return { ok: true };
        }
        const dir = path.dirname(cand);
        if (fs.existsSync(dir)) {
          await shell.openPath(dir);
          return { ok: true, openedDir: dir };
        }
      } catch {}
    }
    throw new Error('no valid path');
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

// Images API：粘贴图片保存 & 剪贴板读取
ipcMain.handle('images.saveDataURL', async (_e, { dataURL, projectWinRoot, projectName, ext, prefix }: { dataURL: string; projectWinRoot?: string; projectName?: string; ext?: string; prefix?: string }) => {
  try {
    const res: any = await images.saveFromDataURL(dataURL, { projectWinRoot, projectName, ext, prefix });
    try { if (res && res.ok && typeof res.winPath === 'string') sessionPastedImages.add(res.winPath); } catch {}
    return res;
  } catch (e: any) {
    return { ok: false, error: String(e) } as any;
  }
});

ipcMain.handle('images.clipboardHasImage', async () => {
  try { return { ok: true, has: images.clipboardHasImage() }; } catch (e: any) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('images.saveFromClipboard', async (_e, { projectWinRoot, projectName, prefix }: { projectWinRoot?: string; projectName?: string; prefix?: string }) => {
  try {
    const res: any = await images.readClipboardAsPNGAndSave({ projectWinRoot, projectName, ext: 'png', prefix });
    try { if (res && res.ok && typeof res.winPath === 'string') sessionPastedImages.add(res.winPath); } catch {}
    return res;
  } catch (e: any) {
    return { ok: false, error: String(e) } as any;
  }
});

ipcMain.handle('images.trash', async (_e, { winPath }: { winPath: string }) => {
  try {
    if (!winPath || typeof winPath !== 'string') throw new Error('invalid path');
    try {
      await fsp.rm(winPath, { force: true });
      return { ok: true };
    } catch (e1: any) {
      return { ok: false, error: String(e1) };
    }
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('utils.openPath', async (_e, { path: p }: { path: string }) => {
  try {
    if (!p || typeof p !== 'string') throw new Error('invalid path');
    const candidates: string[] = [];
    const push = (x?: string) => { if (x && !candidates.includes(x)) candidates.push(x); };
    const normSlashes = (s: string) => (process.platform === 'win32' ? s.replace(/\//g, '\\') : s);
    const raw = String(p);
    push(normSlashes(raw));
    if (process.platform === 'win32') {
      const m = raw.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
      if (m) push(`${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`);
      if (/^\//.test(raw)) {
        try { const unc = wsl.wslToUNC(raw, settings.getSettings().distro || 'Ubuntu-24.04'); push(unc); } catch {}
      }
    }
    for (const cand of candidates) {
      try {
        if (fs.existsSync(cand)) {
          const err = await shell.openPath(cand);
          if (!err) return { ok: true };
        }
      } catch {}
    }
    throw new Error('no valid path');
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

// 打开外部 URL（仅 http/https），避免在渲染进程使用 window.open 导致新窗口执行不受控脚本
ipcMain.handle('utils.openExternalUrl', async (_e, { url }: { url: string }) => {
  try {
    const s = String(url || '').trim();
    if (!/^https?:\/\//i.test(s)) throw new Error('invalid url');
    await shell.openExternal(s);
    return { ok: true } as const;
  } catch (e: any) {
    return { ok: false, error: String(e) } as const;
  }
});

// 列出系统已安装字体（Windows）：解析注册表 HKLM/HKCU 下的 Fonts 键
ipcMain.handle('utils.listFonts', async () => {
  try {
    if (process.platform !== 'win32') return { ok: true, fonts: [] as string[] } as const;
    const execFile = await import('node:child_process').then(m => m.execFile);
    const query = (hive: string): Promise<string> => new Promise((resolve) => {
      try {
        // 以 Buffer 获取原始字节，避免被错误地按 UTF-8 解码
        (execFile as any)('reg.exe', ['query', hive], { encoding: 'buffer', windowsHide: true }, (err: any, stdout: Buffer) => {
          if (err) { resolve(''); return; }
          try { resolve(decodeRegOutput(stdout)); } catch { resolve(String((stdout as any) || '')); }
        });
      } catch { resolve(''); }
    });
    const [sysRaw, userRaw] = await Promise.all([
      query('HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'),
      query('HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'),
    ]);
    const lines = (sysRaw + '\n' + userRaw).split(/\r?\n/);
    const list: string[] = [];
    for (const line of lines) {
      const m = line.match(/^\s*(.+?)\s+REG_SZ\s+/i);
      if (!m) continue;
      let name = m[1].trim();
      // 去掉括号内类型后缀，如 "(TrueType)"、"(OpenType)"
      name = name.replace(/\s*\((TrueType|OpenType)\)$/i, '').trim();
      if (!name) continue;
      // 规整大小写并去重（按不区分大小写）
      if (!list.some((x) => x.toLowerCase() === name.toLowerCase())) list.push(name);
    }
    // 排序：本地化无关的字母序（简单按 toLowerCase 排）
    const fonts = list.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return { ok: true, fonts } as const;
  } catch (e: any) {
    return { ok: false, error: String(e) } as const;
  }
});

// 列出系统字体（含是否等宽）：基于字体文件元数据（post.isFixedPitch / OS/2.PANOSE.Proportion）
ipcMain.handle('utils.listFontsDetailed', async () => {
  try {
    if (process.platform !== 'win32') return { ok: true, fonts: [] as Array<{ name: string; file?: string; monospace: boolean }> } as const;
    if (__fontsDetailedCache && __fontsDetailedCache.length > 0) {
      return { ok: true, fonts: __fontsDetailedCache } as const;
    }
    if (__fontsDetailedPending) {
      return await __fontsDetailedPending;
    }
    const compute = async () => {
      const execFile = await import('node:child_process').then(m => m.execFile);
      const query = (hive: string): Promise<string> => new Promise((resolve) => {
        try {
          (execFile as any)('reg.exe', ['query', hive], { encoding: 'buffer', windowsHide: true }, (err: any, stdout: Buffer) => {
            if (err) { resolve(''); return; }
            try { resolve(decodeRegOutput(stdout)); } catch { resolve(String((stdout as any) || '')); }
          });
        } catch { resolve(''); }
      });
      const [sysRaw, userRaw] = await Promise.all([
        query('HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'),
        query('HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'),
      ]);
      const lines = (sysRaw + '\n' + userRaw).split(/\r?\n/);
      const pairs: Array<{ name: string; file: string }> = [];
      for (const line of lines) {
        const m = line.match(/^\s*(.+?)\s+REG_SZ\s+(.+)$/i);
        if (!m) continue;
        let name = m[1].trim();
        let file = m[2].trim();
        name = name.replace(/\s*\((TrueType|OpenType|Raster)\)$/i, '').trim();
        if (!name) continue;
        const candidates: string[] = [];
        const isAbs = /^(?:[a-zA-Z]:\\|\\\\)/.test(file);
        if (isAbs) {
          candidates.push(file);
        } else {
          const sysFonts = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', file);
          const userFonts = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts', file);
          candidates.push(sysFonts, userFonts);
        }
        let resolved = '';
        for (const cand of candidates) { try { if (fs.existsSync(cand)) { resolved = cand; break; } } catch {} }
        pairs.push({ name, file: resolved || file });
      }
      const seen = new Set<string>();
      const uniques: Array<{ name: string; file: string }> = [];
      for (const p of pairs) {
        const k = p.name.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        uniques.push(p);
      }
      const pLimitLocal = (max: number) => {
        let running = 0; const queue: Array<() => void> = [];
        const next = () => { running--; const fn = queue.shift(); if (fn) fn(); };
        return function <T>(task: () => Promise<T>): Promise<T> {
          return new Promise((resolve, reject) => {
            const run = () => { running++; task().then((v) => { next(); resolve(v); }).catch((e) => { next(); reject(e); }); };
            if (running < max) run(); else queue.push(run);
          });
        };
      };
      const limit = pLimitLocal(3);
      const results: Array<{ name: string; file?: string; monospace: boolean }> = new Array(uniques.length);
      await Promise.all(uniques.map((item, idx) => limit(async () => {
        let monospace = false;
        const file = item.file;
        try {
          if (file && fs.existsSync(file) && /\.(ttf|otf)$/i.test(file)) {
            const buf = await fsp.readFile(file);
            let arrayBuffer: ArrayBuffer;
            const raw = buf.buffer;
            if (raw instanceof ArrayBuffer) {
              if (buf.byteOffset === 0 && buf.byteLength === raw.byteLength) {
                arrayBuffer = raw.slice(0) as ArrayBuffer;
              } else {
                arrayBuffer = raw.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
              }
            } else {
              arrayBuffer = new ArrayBuffer(buf.byteLength);
              new Uint8Array(arrayBuffer).set(buf);
            }
            const font = opentype.parse(arrayBuffer);
            const post: any = (font as any)?.tables?.post;
            const os2: any = (font as any)?.tables?.os2;
            if (post && typeof post.isFixedPitch === 'number') monospace = !!post.isFixedPitch;
            if (!monospace && os2 && os2.panose) {
              const pan = os2.panose;
              if (Array.isArray(pan) && pan.length >= 4) monospace = Number(pan[3]) === 9;
              else if (typeof pan === 'object' && pan !== null && typeof (pan as any).proportion !== 'undefined') monospace = Number((pan as any).proportion) === 9;
            }
          }
        } catch {}
        results[idx] = { name: item.name, file: fs.existsSync(file) ? file : undefined, monospace };
      })));
      results.sort((a, b) => (Number(b.monospace) - Number(a.monospace)) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      return results;
    };
    __fontsDetailedPending = (async () => {
      try {
        const fonts = await compute();
        __fontsDetailedCache = fonts;
        __fontsDetailedCacheAt = Date.now();
        return { ok: true, fonts } as const;
      } catch (e: any) {
        return { ok: false, error: String(e), fonts: [] } as const;
      } finally {
        __fontsDetailedPending = null;
      }
    })();
    return await __fontsDetailedPending;
  } catch (e: any) {
    return { ok: false, error: String(e), fonts: [] } as const;
  }
});

// 系统信息（用于渲染层判定 Windows 构建号，从而启用 xterm reflow）
ipcMain.handle('utils.getWindowsInfo', async () => {
  try {
    const platform = process.platform;
    if (platform !== 'win32') return { ok: true, platform } as const;
    const rel = os.release() || '';
    let buildNumber: number | undefined = undefined;
    try {
      const m = rel.match(/^\d+\.\d+\.(\d+)/);
      if (m && m[1]) buildNumber = Math.max(0, Number(m[1]));
    } catch {}
    const conptyAvailable = typeof buildNumber === 'number' ? (buildNumber >= 18362) : true;
    const backend = conptyAvailable ? 'conpty' : 'winpty';
    return { ok: true, platform, buildNumber, backend, conptyAvailable } as const;
  } catch (e: any) {
    return { ok: false, error: String(e) } as const;
  }
});
ipcMain.handle('utils.detectPwsh', async () => {
  try {
    const path = await detectPwshExecutable();
    return { ok: true, available: !!path, path: path || undefined } as const;
  } catch (e: any) {
    return { ok: false, error: String(e), available: false } as const;
  }
});

// 应用版本与资源路径（用于 About 页面与打开 LICENSE/NOTICE）
ipcMain.handle('app.getVersion', async () => {
  try { return { ok: true, version: app.getVersion() }; } catch (e: any) { return { ok: false, error: String(e) }; }
});
ipcMain.handle('app.getPaths', async () => {
  try {
    const isDev = !app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
    const root = isDev ? process.cwd() : path.join(process.resourcesPath, 'app');
    const licensePath = path.join(root, 'LICENSE');
    const noticePath = path.join(root, 'NOTICE');
    return { ok: true, licensePath, noticePath } as const;
  } catch (e: any) {
    return { ok: false, error: String(e) } as const;
  }
});

ipcMain.handle('app.getEnvMeta', async () => {
  try {
    const isDev = !app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
    const devServerUrl = String(process.env.DEV_SERVER_URL || '').trim();
    const protocol = devServerUrl && /^https?:/i.test(devServerUrl) ? 'http' : 'file';
    return { ok: true, isDev, devServerUrl: devServerUrl || null, protocol } as const;
  } catch (e: any) {
    return { ok: false, error: String(e) } as const;
  }
});

// 打开外部 WSL 控制台（以"打开 WSL 终端 -> cd 到目录 -> 执行 codex"为准则，优先稳健性）
  ipcMain.handle('utils.openExternalWSLConsole', async (_e, args: { wslPath?: string; winPath?: string; distro?: string; startupCmd?: string }) => {
  try {
    const platform = process.platform;
    const requestedDistro = String(args?.distro || settings.getSettings().distro || 'Ubuntu-24.04');
    let wslPath = String(args?.wslPath || '').trim();
    const winPath = String(args?.winPath || '').trim();
    const startupCmd = String(args?.startupCmd || settings.getSettings().codexCmd || 'codex');

    const guardKey = [
      "openExternalWSLConsole",
      platform,
      requestedDistro,
      wslPath,
      winPath,
      startupCmd,
    ].join("|");
    if (shouldSkipExternalConsoleLaunch(guardKey)) return { ok: true, skipped: true } as const;

    // 路径转换：若仅给了 Windows 路径，转换为 WSL 路径；均为空则使用 ~
    if (!wslPath && winPath) {
      try { wslPath = wsl.winToWsl(winPath, requestedDistro); } catch {}
    }
    if (!wslPath) wslPath = '~';

    // 组装 bash -lic 脚本：进入目录 -> 执行 codex -> 保持会话
    const esc = (s: string) => s.replace(/"/g, '\\"'); // 用于双引号内转义
    const cdCmd = wslPath === '~' ? 'cd ~' : `cd "${esc(wslPath)}"`;
    // 注意：避免在这里拼接 `;`，否则 Windows Terminal `wt.exe` 可能把 `;` 当作命令分隔符解析，
    // 进而把脚本拆成多段（如 if/then/else/fi），导致连开多个窗口并报错。
    const bashScript = `(${cdCmd} || true) && (${startupCmd} || true) && exec bash`;

    if (platform === 'win32') {
      // 仅当发行版存在时才附加 -d <distro>，否则回退到默认发行版
      const hasDistro = (() => { try { return wsl.distroExists(requestedDistro); } catch { return false; } })();
      const distroArgv = hasDistro ? ['-d', requestedDistro] as string[] : [];

      // 方案 A：Windows Terminal（new-tab，避免旧别名 nt），若存在则直接新开标签
      const canUseWt = !bashScript.includes(';');
      const wslExe = resolveSystemBinary('wsl.exe');
      const wtArgs = ['-w', '0', 'new-tab', '--title', 'Codex', '--', wslExe, ...distroArgv, '--', 'bash', '-lic', bashScript];
      if (canUseWt) {
        if (await spawnDetachedSafe('wt.exe', wtArgs, WT_VISIBLE_SPAWN_OPTS)) return { ok: true } as const;
        if (await spawnDetachedSafe('WindowsTerminal.exe', wtArgs, WT_VISIBLE_SPAWN_OPTS)) return { ok: true } as const;
      }

      // 方案 B：PowerShell Start-Process（不依赖 --cd，直接在 bash 中 cd）
      const psArgListParts = [
        ...(hasDistro ? [`'-d'`, `'${requestedDistro.replace(/'/g, "''")}'`] : []),
        `'--'`, `'bash'`, `'-lic'`, `'${bashScript.replace(/'/g, "''")}'`
      ];
      const wslExePs = wslExe.replace(/'/g, "''");
      const psCmd = `Start-Process -FilePath '${wslExePs}' -ArgumentList @(${psArgListParts.join(',')}) -WindowStyle Normal`;
      {
        const powershellExe = resolveSystemBinary('powershell.exe');
        if (await spawnDetachedSafe(powershellExe, ['-NoProfile', '-NonInteractive', '-Command', psCmd], { windowsHide: false })) return { ok: true } as const;
      }

      // 方案 C：cmd.exe /c start（最后兜底，且必须传空标题 `""`）
      {
        const cmdExe = resolveSystemBinary('cmd.exe');
        if (await spawnDetachedSafe(cmdExe, ['/c', 'start', '', wslExe, ...distroArgv, '--', 'bash', '-lic', bashScript], { windowsHide: false })) return { ok: true } as const;
      }

      throw new Error('failed to launch external WSL console');
    }

    // 非 Windows：尽力尝试常见终端（用于开发调试环境）
    const candidates: Array<{ cmd: string; args: string[] }> = [
      { cmd: 'x-terminal-emulator', args: ['-e', 'bash', '-lc', bashScript] },
      { cmd: 'gnome-terminal', args: ['--', 'bash', '-lc', bashScript] },
      { cmd: 'konsole', args: ['-e', 'bash', '-lc', bashScript] },
      { cmd: 'xterm', args: ['-e', 'bash', '-lc', bashScript] },
    ];
    for (const c of candidates) {
      try {
        const child = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', cwd: process.env.HOME });
        child.on('error', () => {});
        child.unref();
        return { ok: true } as const;
      } catch {}
    }
    throw new Error('no terminal available');
  } catch (e: any) {
    return { ok: false, error: String(e) } as const;
  }
});

// 打开选择目录对话并返回选中的 Windows 路径（若取消则返回 canceled）
ipcMain.handle('utils.chooseFolder', async (_e) => {
  try {
    const win = BrowserWindow.getFocusedWindow();
    const opts = { properties: ['openDirectory'] } as any;
    const ret = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (!ret || ret.canceled || !Array.isArray(ret.filePaths) || ret.filePaths.length === 0) return { ok: false, canceled: true };
    return { ok: true, path: ret.filePaths[0] };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

// Path helpers
ipcMain.handle('utils.pathExists', async (_e, args: { path: string; dirOnly?: boolean }) => {
  try {
    const p = String(args?.path || '');
    if (!p) return { ok: true, exists: false, isDirectory: false, isFile: false } as any;
    const fsp = await import('node:fs/promises');
    const st = await fsp.stat(p).catch(() => null as any);
    if (!st) return { ok: true, exists: false, isDirectory: false, isFile: false } as any;
    const isDirectory = st.isDirectory();
    const isFile = st.isFile();
    if (args?.dirOnly) {
      return { ok: true, exists: isDirectory, isDirectory, isFile } as any;
    }
    return { ok: true, exists: true, isDirectory, isFile } as any;
  } catch (e: any) {
    return { ok: false, error: String(e) } as any;
  }
});

ipcMain.handle("codex.accountInfo", async () => {
  try {
    const bridge = ensureCodexBridge();
    const cfg = settings.getSettings() as any;
    const recordEnabled = !!cfg?.codexAccount?.recordEnabled;
    const info = await bridge.getAccountInfo(recordEnabled);
    try { await maybeAutoBackupCodexAuthJsonOnAccountRefresh(info, resolveCodexBridgeTarget()); } catch {}
    return { ok: true, info };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("codex.authBackups.list", async () => {
  try {
    const runtime = resolveCodexBridgeTarget();
    const items = await listCodexAuthBackupsAsync(runtime.key);
    return { ok: true, items };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("codex.authBackups.apply", async (_e, args: { id: string }) => {
  try {
    const runtime = resolveCodexBridgeTarget();
    const backupId = String(args?.id || "").trim().toLowerCase();
    if (!isSafeAuthBackupId(backupId)) return { ok: false, error: "invalid backup id" };

    const authRes = await resolveCodexAuthJsonPathAsync(runtime);
    if (!authRes.ok) return { ok: false, error: authRes.error };

    const cfg = settings.getSettings() as any;
    const recordEnabled = !!cfg?.codexAccount?.recordEnabled;

    // 若启用了“记录账号”，切换前先备份一次当前 auth.json，避免覆盖丢失
    if (recordEnabled) {
      try {
        const bridge = ensureCodexBridge();
        const current = await bridge.getAccountInfo(true);
        const sig = resolveCodexAccountSignature(current);
        if (sig.status === "signed_in") {
          await upsertCodexAuthBackupAsync({
            runtimeKey: runtime.key,
            authJsonPath: authRes.authJsonPath,
            signature: sig.signature,
            status: sig.status,
            accountId: sig.accountId,
            userId: current?.userId ?? null,
            email: current?.email ?? null,
            plan: current?.plan ?? null,
            reason: "before-switch",
          });
        }
      } catch {}
    }

    const applyRes = await applyCodexAuthBackupAsync({
      runtimeKey: runtime.key,
      backupId,
      targetAuthJsonPath: authRes.authJsonPath,
    });
    if (!applyRes.ok) return { ok: false, error: applyRes.error };

    // 切换后强制重启 bridge，避免旧 token 缓存影响账号识别/用量拉取
    try { disposeCodexBridges(); } catch {}

    // 同步更新“最近识别签名”，避免下一次刷新重复触发备份
    if (recordEnabled) {
      try {
        const meta = await readCodexAuthBackupMetaAsync(runtime.key, backupId);
        if (meta && meta.signature) {
          const lastMapRaw = cfg?.codexAccount?.lastSeenSignatureByRuntime;
          const lastMap = (lastMapRaw && typeof lastMapRaw === "object") ? (lastMapRaw as Record<string, string>) : {};
          const nextMap = { ...lastMap, [runtime.key]: String(meta.signature || "").trim() };
          settings.updateSettings({ codexAccount: { ...cfg?.codexAccount, recordEnabled: true, lastSeenSignatureByRuntime: nextMap } as any });
        }
      } catch {}
    }

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("codex.authBackups.delete", async (_e, args: { id: string }) => {
  try {
    const runtime = resolveCodexBridgeTarget();
    const backupId = String(args?.id || "").trim().toLowerCase();
    if (!isSafeAuthBackupId(backupId)) return { ok: false, error: "invalid backup id" };

    const cfg = settings.getSettings() as any;
    const recordEnabled = !!cfg?.codexAccount?.recordEnabled;

    const delRes = await deleteCodexAuthBackupAsync({ runtimeKey: runtime.key, backupId });
    if (!delRes.ok) return delRes;

    // 用户手动删除后：强制清空该运行环境的“最近识别签名”，保证下次刷新可重新备份/补齐 meta。
    if (recordEnabled) {
      try {
        const lastMapRaw = cfg?.codexAccount?.lastSeenSignatureByRuntime;
        const lastMap = (lastMapRaw && typeof lastMapRaw === "object") ? (lastMapRaw as Record<string, string>) : {};
        if (lastMap[runtime.key]) {
          const nextMap = { ...lastMap };
          delete nextMap[runtime.key];
          settings.updateSettings({ codexAccount: { ...cfg?.codexAccount, recordEnabled: true, lastSeenSignatureByRuntime: nextMap } as any });
        }
      } catch {}
    }

    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("codex.rateLimit", async () => {
  try {
    const bridge = ensureCodexBridge();
    const snapshot = await bridge.getRateLimit();
    return { ok: true, snapshot };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

/**
 * 读取设置中的 Provider 环境（若缺失则回退到全局 terminal/distro）。
 */
function resolveProviderRuntimeEnv(providerId: "claude" | "gemini"): { terminal: "wsl" | "windows" | "pwsh"; distro?: string } {
  const cfg = settings.getSettings() as any;
  const globalTerminal = (cfg?.terminal as any) || "wsl";
  const globalDistro = (cfg?.distro as any) || undefined;
  const env = (cfg?.providers?.env && cfg.providers.env[providerId]) ? cfg.providers.env[providerId] : {};
  const terminal = (env?.terminal as any) || globalTerminal || "wsl";
  const distro = (env?.distro as any) || globalDistro || undefined;
  return { terminal, distro };
}

ipcMain.handle("claude.usage", async () => {
  try {
    const env = resolveProviderRuntimeEnv("claude");
    const snapshot = await getClaudeUsageSnapshotAsync(env);
    return { ok: true, snapshot };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("gemini.usage", async () => {
  try {
    const env = resolveProviderRuntimeEnv("gemini");
    const snapshot = await getGeminiQuotaSnapshotAsync(env);
    return { ok: true, snapshot };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

// Settings
ipcMain.handle('settings.get', async () => {
  try { await ensureSettingsAutodetect(); } catch {}
  try { await ensureAllCodexNotifications(); } catch {}
  const cfg = settings.getSettings() as any;
  try {
    const flags = getFeatureFlags();
    cfg.experimental = { ...(cfg.experimental || {}), multiInstanceEnabled: !!flags.multiInstanceEnabled };
  } catch {}
  return cfg;
});

ipcMain.handle('settings.update', async (_e, partial: any) => {
  let prevDescriptor: CodexBridgeDescriptor | null = null;
  let prevClaudeAgentHistory = false;
  let prevCodexAccountRecordEnabled = false;
  try {
    prevDescriptor = deriveCodexBridgeDescriptor(settings.getSettings());
    prevClaudeAgentHistory = !!(settings.getSettings() as any)?.claudeCode?.readAgentHistory;
    prevCodexAccountRecordEnabled = !!(settings.getSettings() as any)?.codexAccount?.recordEnabled;
    if (partial && typeof partial.locale === 'string' && partial.locale.trim()) {
      // 使用 i18n 通道更新并广播语言，同时继续保存其它设置字段
      try { i18n.setCurrentLocale(String(partial.locale)); } catch {}
    }
  } catch {}
  // 处理实验性功能开关（全局共享，不随 profile 隔离）
  let updatedMultiInstance: boolean | null = null;
  try {
    const exp = partial && typeof partial === "object" ? (partial as any).experimental : null;
    if (exp && typeof exp === "object" && Object.prototype.hasOwnProperty.call(exp, "multiInstanceEnabled")) {
      updatedMultiInstance = updateFeatureFlags({ multiInstanceEnabled: !!exp.multiInstanceEnabled }).multiInstanceEnabled;
    }
  } catch {}
  // experimental 不写入 profile settings.json（保持全局一致）
  const cleanPartial = (() => {
    try {
      if (!partial || typeof partial !== "object") return {};
      const clone = { ...(partial as any) };
      if (Object.prototype.hasOwnProperty.call(clone, "experimental")) delete (clone as any).experimental;
      return clone;
    } catch {
      return partial || {};
    }
  })();

  const next = settings.updateSettings(cleanPartial || {});
  const nextClaudeAgentHistory = !!(next as any)?.claudeCode?.readAgentHistory;
  const nextCodexAccountRecordEnabled = !!(next as any)?.codexAccount?.recordEnabled;
  try {
    const nextDescriptor = deriveCodexBridgeDescriptor(next);
    if (!prevDescriptor || nextDescriptor.key !== prevDescriptor.key) {
      disposeCodexBridgesExcept(nextDescriptor.key);
    }
  } catch {}
  // 设置更新后尝试刷新代理
  try { await configureOrUpdateProxy(); } catch {}
  try { await ensureAllCodexNotifications(); } catch {}
  // 若刚开启“记录账号”，立即刷新一次账号信息并触发初始备份（便于立刻出现在备份列表）
  try {
    if (!prevCodexAccountRecordEnabled && nextCodexAccountRecordEnabled) {
      const runtime = deriveCodexBridgeDescriptor(next);
      const bridge = ensureCodexBridge();
      const info = await bridge.getAccountInfo(true);
      await maybeAutoBackupCodexAuthJsonOnAccountRefresh(info, runtime);
    }
  } catch {}
  // Claude Code 过滤开关变更：重启历史索引器以立即生效（包含增量移除/新增）。
  try {
    if (prevClaudeAgentHistory !== nextClaudeAgentHistory) {
      startHistoryIndexer(() => mainWindow).catch(() => {});
      try { mainWindow?.webContents.send('history:index:invalidate', { reason: 'settings' }); } catch {}
    }
  } catch {}
  const merged = next as any;
  try {
    const flags = getFeatureFlags();
    const enabled = updatedMultiInstance == null ? !!flags.multiInstanceEnabled : !!updatedMultiInstance;
    merged.experimental = { ...(merged.experimental || {}), multiInstanceEnabled: enabled };
  } catch {}
  return merged;
});

// Read-only: return the .codex/sessions roots that are currently in use (or can be detected quickly)
ipcMain.handle('settings.codexRoots', async () => {
  try {
    const fromIndexer = getLastIndexerRoots();
    if (fromIndexer && fromIndexer.length > 0) {
      // 仅返回仍存在的目录
      const fs = await import('node:fs/promises');
      const filtered: string[] = [];
      for (const r of fromIndexer) { try { const st = await fs.stat(r); if (st.isDirectory()) filtered.push(r); } catch {} }
      return { ok: true, roots: filtered };
    }
  } catch {}
  try {
    const roots = await getSessionsRootsFastAsync();
    return { ok: true, roots };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

// Read-only: return the detected session roots for a given provider (codex/claude/gemini)
ipcMain.handle('settings.sessionRoots', async (_e, args: { providerId?: string }) => {
  const id = String(args?.providerId || 'codex').trim().toLowerCase();
  try {
    const fromIndexer = getLastIndexerRootsByProvider(id);
    if (fromIndexer && fromIndexer.length > 0) {
      const fs = await import('node:fs/promises');
      const filtered: string[] = [];
      for (const r of fromIndexer) { try { const st = await fs.stat(r); if (st.isDirectory()) filtered.push(r); } catch {} }
      return { ok: true, roots: filtered };
    }
  } catch {}
  try {
    if (id === 'codex') {
      const roots = await getSessionsRootsFastAsync();
      return { ok: true, roots };
    }
    if (id === 'claude') {
      const cands = await getClaudeRootCandidatesFastAsync();
      return { ok: true, roots: cands.filter((c) => c.exists).map((c) => c.path) };
    }
    if (id === 'gemini') {
      const cands = await getGeminiRootCandidatesFastAsync();
      return { ok: true, roots: cands.filter((c) => c.exists).map((c) => c.path) };
    }
    return { ok: true, roots: [] as string[] };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});
ipcMain.handle('storage.appData.info', async () => {
  try {
    return await storage.getAppDataInfo();
  } catch (e: any) {
    return {
      ok: false,
      path: '',
      totalBytes: 0,
      dirCount: 0,
      fileCount: 0,
      collectedAt: Date.now(),
      error: String(e),
    };
  }
});
ipcMain.handle('storage.appData.clear', async (_e, args: { preserveSettings?: boolean } = {}) => {
  try {
    return await storage.clearAppData(args);
  } catch (e: any) {
    return {
      ok: false,
      path: '',
      bytesBefore: 0,
      bytesAfter: 0,
      bytesFreed: 0,
      removedEntries: 0,
      skippedEntries: 0,
      error: String(e),
    };
  }
});
ipcMain.handle('storage.appData.purgeAndQuit', async () => {
  try {
    disposeAllPtys();
    disposeCodexBridges();
    await cleanupPastedImages();
    await stopHistoryIndexer();
    return await storage.purgeAppDataAndQuit();
  } catch (e: any) {
    return {
      ok: false,
      path: '',
      bytesBefore: 0,
      bytesAfter: 0,
      bytesFreed: 0,
      removedEntries: 0,
      skippedEntries: 0,
      error: String(e),
    };
  }
});
ipcMain.handle('storage.autoProfiles.info', async () => {
  try {
    return await (storage as any).getAutoProfilesInfo();
  } catch (e: any) {
    return {
      ok: false,
      baseUserData: '',
      currentUserData: '',
      count: 0,
      totalBytes: 0,
      items: [],
      error: String(e),
    };
  }
});
ipcMain.handle('storage.autoProfiles.purge', async (_e, args: { includeCurrent?: boolean } = {}) => {
  try {
    return await (storage as any).purgeAutoProfiles(args);
  } catch (e: any) {
    return {
      ok: false,
      total: 0,
      removed: 0,
      skipped: 0,
      busy: 0,
      notFound: 0,
      bytesFreed: 0,
      error: String(e),
    };
  }
});

// 返回可用 WSL 发行版列表（仅列出名称）
ipcMain.handle('wsl.listDistros', async () => {
  try {
    const ds = await Promise.resolve(require('./wsl').listDistrosAsync());
    return { ok: true, distros: ds };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
});

// WSL helpers
// (trimmed) removed unused wsl.* renderer IPC handlers
  // Debug term logs (main process PTY): expose IPC to get/set via unified debug config
  ipcMain.handle('utils.debugTerm.get', () => {
    try { return { ok: true, enabled: !!getDebugConfig().terminal.pty.debug }; } catch { return { ok: true, enabled: false }; }
  });
  ipcMain.handle('utils.debugTerm.set', (_e, { enabled }: { enabled: boolean }) => {
    try { const cur = getDebugConfig(); updateDebugConfig({ terminal: { ...cur.terminal, pty: { debug: !!enabled } } as any }); setTermDebug(!!enabled); return { ok: true }; } catch (e: any) { return { ok: false, error: String(e) }; }
  });

  // Debug config API for renderer
  ipcMain.handle('debug.get', () => { try { return getDebugConfig(); } catch { return readDebugConfig(); } });
  ipcMain.handle('debug.update', (_e, partial: any) => { try { const next = updateDebugConfig(partial || {}); return { ok: true, config: next }; } catch (e: any) { return { ok: false, error: String(e) }; } });
  ipcMain.handle('debug.reset', () => { try { const next = resetDebugConfig(); return { ok: true, config: next }; } catch (e: any) { return { ok: false, error: String(e) }; } });
