// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { execFile } from "node:child_process";
import * as pty from "node-pty";
import { perfLogger } from "../log";

export type AntigravityUsageWindow = {
  label: string;
  groupName?: string | null;
  bucketId?: string | null;
  modelId?: string | null;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetText?: string | null;
  resetAt?: number | null;
  usageKnown: boolean;
};

export type AntigravityUsageSnapshot = {
  providerId: "antigravity";
  source: "app-local" | "agy-cli" | "ide-local" | "launched-agy" | "local";
  rawSource: "quota-summary" | "user-status" | "command-model-configs";
  collectedAt: number;
  accountEmail?: string | null;
  planName?: string | null;
  windows: AntigravityUsageWindow[];
};

type ProcessKind = "app" | "ide" | "cli" | "unknown";

type ProcessCandidate = {
  pid: number;
  name?: string;
  commandLine: string;
  kind: ProcessKind;
  csrfToken?: string;
  extensionServerCsrfToken?: string;
  extensionPort?: number;
};

type LocalEndpoint = {
  port: number;
  protocol: "https" | "http";
  csrfToken?: string;
  candidate: ProcessCandidate;
};

type LocalJsonResponse = {
  status: number;
  data: any;
  raw: string;
};

type WarmAgySession = {
  proc: pty.IPty;
  pid: number | null;
  executable: string;
  startedAt: number;
  lastUsedAt: number;
  killTimer: NodeJS.Timeout | null;
};

const QUOTA_SUMMARY_PATH = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const GET_USER_STATUS_PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const COMMAND_MODEL_CONFIG_PATH = "/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs";

const ANTIGRAVITY_REQUEST_BODY = {
  metadata: {
    ideName: "antigravity",
    extensionName: "antigravity",
    locale: "en",
    ideVersion: "unknown",
  },
};

const LOCAL_REQUEST_TIMEOUT_MS = 2500;
const PROCESS_SCAN_TIMEOUT_MS = 8000;
const AGY_READY_TIMEOUT_MS = 15_000;
const AGY_WARM_IDLE_MS = 45_000;

let warmAgySession: WarmAgySession | null = null;

/**
 * 执行命令并读取 stdout，所有探测命令都必须有超时。
 */
function execFileTextAsync(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
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
 * 将输入解析为有限数字。
 */
function asFiniteNumber(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(num) ? num : null;
}

/**
 * 将百分比限制到 0-100。
 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/**
 * 将 remainingFraction 转成剩余百分比。
 */
function fractionToRemainingPercent(value: unknown): number | null {
  const num = asFiniteNumber(value);
  if (num == null) return null;
  if (num >= 0 && num <= 1) return clampPercent(num * 100);
  return clampPercent(num);
}

/**
 * 由剩余百分比计算已用百分比。
 */
function usedFromRemainingPercent(value: number | null): number | null {
  if (value == null) return null;
  return clampPercent(100 - value);
}

/**
 * 解析可选时间戳。
 */
function parseResetAtMs(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const asNumber = Number(text);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    const ms = asNumber > 10_000_000_000 ? asNumber : asNumber * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 提取命令行中的 flag 值，支持 `--name value` 和 `--name=value`。
 */
function extractFlagValue(commandLine: string, flag: string): string {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s]+))`, "i");
  const match = re.exec(commandLine);
  return String(match?.[1] || match?.[2] || match?.[3] || "").trim();
}

/**
 * 解析 Antigravity 进程类别。
 */
function resolveProcessKind(name: string | undefined, commandLine: string): ProcessKind {
  const n = String(name || "").toLowerCase();
  const cmd = String(commandLine || "").toLowerCase();
  if (n === "agy.exe" || n === "agy" || /(^|[\\/])agy(\.exe)?(?:"|\s|$)/i.test(commandLine) || cmd.includes("antigravity-cli"))
    return "cli";
  if (cmd.includes("antigravity-ide") || /--app_data_dir(?:=|\s+)antigravity-ide\b/i.test(commandLine))
    return "ide";
  if (cmd.includes("antigravity") || /--app_data_dir(?:=|\s+)antigravity\b/i.test(commandLine))
    return "app";
  return "unknown";
}

/**
 * 判断进程是否可能是 Antigravity 本地服务或 AGY CLI。
 */
function isAntigravityCandidateProcess(name: string | undefined, commandLine: string): boolean {
  const n = String(name || "").toLowerCase();
  const cmd = String(commandLine || "").toLowerCase();
  if (n === "agy.exe" || n === "agy") return true;
  if (!n.includes("language_server") && !n.includes("language-server")) return false;
  return cmd.includes("antigravity")
    || /--app_data_dir(?:=|\s+)antigravity(?:-ide)?\b/i.test(commandLine);
}

/**
 * 从进程信息构造候选。
 */
function toProcessCandidate(row: any): ProcessCandidate | null {
  const pid = asFiniteNumber(row?.ProcessId ?? row?.pid);
  if (pid == null || pid <= 0) return null;
  const name = String(row?.Name ?? row?.name ?? "").trim();
  const commandLine = String(row?.CommandLine ?? row?.commandLine ?? row?.args ?? "").trim();
  if (!isAntigravityCandidateProcess(name, commandLine)) return null;
  const kind = resolveProcessKind(name, commandLine);
  if (kind === "unknown") return null;
  const csrfToken = extractFlagValue(commandLine, "--csrf_token");
  const extensionServerCsrfToken = extractFlagValue(commandLine, "--extension_server_csrf_token");
  const extensionPort = asFiniteNumber(extractFlagValue(commandLine, "--extension_server_port"));
  return {
    pid,
    name,
    commandLine,
    kind,
    csrfToken: csrfToken || undefined,
    extensionServerCsrfToken: extensionServerCsrfToken || undefined,
    extensionPort: extensionPort && extensionPort > 0 ? extensionPort : undefined,
  };
}

/**
 * 解析 PowerShell JSON 输出。
 */
function parseJsonRows(text: string): any[] {
  const raw = String(text || "").trim();
  if (!raw) return [];
  try {
    const obj = JSON.parse(raw);
    if (Array.isArray(obj)) return obj;
    if (obj && typeof obj === "object") return [obj];
  } catch {}
  return [];
}

/**
 * 列出 Windows 侧 Antigravity/AGY 候选进程。
 */
async function listWindowsProcessCandidatesAsync(): Promise<ProcessCandidate[]> {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$items = Get-CimInstance Win32_Process | Where-Object { ($_.Name -match 'language_server|agy|antigravity') -or ($_.CommandLine -match 'antigravity|antigravity-cli|antigravity-ide|(^|[\\\\/])agy(\\.exe)?(?=\"|\\s|$)') }",
    "$items | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3",
  ].join("; ");
  const stdout = await execFileTextAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], PROCESS_SCAN_TIMEOUT_MS);
  return parseJsonRows(stdout).map(toProcessCandidate).filter((x): x is ProcessCandidate => !!x);
}

/**
 * 列出 Unix 侧 Antigravity/AGY 候选进程。
 */
async function listUnixProcessCandidatesAsync(): Promise<ProcessCandidate[]> {
  const stdout = await execFileTextAsync("ps", ["-ww", "-eo", "pid=,comm=,args="], PROCESS_SCAN_TIMEOUT_MS);
  const out: ProcessCandidate[] = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const candidate = toProcessCandidate({ pid: Number(match[1]), name: match[2], commandLine: match[3] });
    if (candidate) out.push(candidate);
  }
  return out;
}

/**
 * 列出 Antigravity/AGY 候选进程。
 */
async function listProcessCandidatesAsync(): Promise<ProcessCandidate[]> {
  try {
    const list = os.platform() === "win32"
      ? await listWindowsProcessCandidatesAsync()
      : await listUnixProcessCandidatesAsync();
    return prioritizeProcessCandidates(list);
  } catch (error) {
    try { perfLogger.log(`[antigravity.usage] process scan failed: ${String(error)}`); } catch {}
    return [];
  }
}

/**
 * 对候选进程排序：App 与已运行 AGY 优先，IDE 作为兜底。
 */
function prioritizeProcessCandidates(list: ProcessCandidate[]): ProcessCandidate[] {
  const rank = (kind: ProcessKind) => kind === "app" ? 0 : kind === "cli" ? 1 : kind === "ide" ? 2 : 3;
  return [...list].sort((a, b) => rank(a.kind) - rank(b.kind));
}

/**
 * 解析 Windows Get-NetTCPConnection 输出。
 */
function parseWindowsTcpRows(text: string, pid: number): number[] {
  const rows = parseJsonRows(text);
  const ports = new Set<number>();
  for (const row of rows) {
    const owner = asFiniteNumber(row?.OwningProcess);
    if (owner !== pid) continue;
    const state = String(row?.State || "").toLowerCase();
    if (state && state !== "listen") continue;
    const port = asFiniteNumber(row?.LocalPort);
    if (port && port > 0) ports.add(port);
  }
  return Array.from(ports).sort((a, b) => a - b);
}

/**
 * 通过 Get-NetTCPConnection 获取 Windows 监听端口。
 */
async function listWindowsListeningPortsPowerShellAsync(pid: number): Promise<number[]> {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$items = Get-NetTCPConnection -State Listen -OwningProcess ${Math.floor(pid)}`,
    "$items | Select-Object LocalAddress,LocalPort,OwningProcess,State | ConvertTo-Json -Compress -Depth 3",
  ].join("; ");
  const stdout = await execFileTextAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], 5000);
  return parseWindowsTcpRows(stdout, pid);
}

/**
 * 通过 netstat 兜底获取 Windows 监听端口。
 */
async function listWindowsListeningPortsNetstatAsync(pid: number): Promise<number[]> {
  const stdout = await execFileTextAsync("netstat.exe", ["-ano", "-p", "TCP"], 5000);
  const ports = new Set<number>();
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!new RegExp(`\\s${Math.floor(pid)}\\s*$`).test(line)) continue;
    if (!/\bLISTENING\b/i.test(line)) continue;
    const match = /(?:\d+\.\d+\.\d+\.\d+|\[?::1\]?|\[?::\]?|0\.0\.0\.0):(\d+)/.exec(line);
    const port = asFiniteNumber(match?.[1]);
    if (port && port > 0) ports.add(port);
  }
  return Array.from(ports).sort((a, b) => a - b);
}

/**
 * 获取 Unix 监听端口。
 */
async function listUnixListeningPortsAsync(pid: number): Promise<number[]> {
  const ports = new Set<number>();
  try {
    const stdout = await execFileTextAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(Math.floor(pid))], 5000);
    for (const line of String(stdout || "").split(/\r?\n/)) {
      const match = /(?:127\.0\.0\.1|localhost|\[?::1\]?):(\d+).*LISTEN/i.exec(line);
      const port = asFiniteNumber(match?.[1]);
      if (port && port > 0) ports.add(port);
    }
  } catch {}
  return Array.from(ports).sort((a, b) => a - b);
}

/**
 * 获取指定进程的监听端口。
 */
async function listListeningPortsAsync(pid: number): Promise<number[]> {
  if (os.platform() === "win32") {
    const viaPs = await listWindowsListeningPortsPowerShellAsync(pid).catch(() => []);
    if (viaPs.length > 0) return viaPs;
    return listWindowsListeningPortsNetstatAsync(pid).catch(() => []);
  }
  return listUnixListeningPortsAsync(pid).catch(() => []);
}

/**
 * 根据端口列表为候选进程生成本地请求端点。
 */
function buildEndpointsForCandidate(candidate: ProcessCandidate, portList: readonly number[]): LocalEndpoint[] {
  const ports = new Set<number>();
  for (const port of portList) {
    if (port > 0) ports.add(port);
  }
  const endpoints: LocalEndpoint[] = [];
  const csrfToken = candidate.kind === "cli" ? undefined : candidate.csrfToken;
  if (candidate.kind === "cli") {
    for (const port of ports) {
      endpoints.push({ port, protocol: "https", csrfToken, candidate });
      endpoints.push({ port, protocol: "http", csrfToken, candidate });
    }
    return endpoints;
  }

  if (csrfToken) {
    for (const port of ports)
      endpoints.push({ port, protocol: "https", csrfToken, candidate });
  }

  if (candidate.extensionPort) {
    const extensionCsrfToken = candidate.extensionServerCsrfToken || candidate.csrfToken;
    if (!extensionCsrfToken) return endpoints;
    endpoints.push({
      port: candidate.extensionPort,
      protocol: "http",
      csrfToken: extensionCsrfToken,
      candidate,
    });
  }
  return endpoints;
}

/**
 * 为候选进程生成本地请求端点列表。
 */
async function buildEndpointsForCandidateAsync(candidate: ProcessCandidate): Promise<LocalEndpoint[]> {
  return buildEndpointsForCandidate(candidate, await listListeningPortsAsync(candidate.pid));
}

/**
 * 请求本机 Antigravity JSON 接口。
 */
function requestLocalJsonAsync(endpoint: LocalEndpoint, requestPath: string, timeoutMs = LOCAL_REQUEST_TIMEOUT_MS): Promise<LocalJsonResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(ANTIGRAVITY_REQUEST_BODY);
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Connect-Protocol-Version": "1",
    };
    if (endpoint.csrfToken) headers["X-Codeium-Csrf-Token"] = endpoint.csrfToken;

    const options: https.RequestOptions = {
      hostname: "127.0.0.1",
      port: endpoint.port,
      path: requestPath,
      method: "POST",
      headers,
      timeout: Math.max(1000, timeoutMs),
      rejectUnauthorized: false,
    };
    const client = endpoint.protocol === "https" ? https : http;
    const req = client.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let data: any = null;
        try { data = raw ? JSON.parse(raw) : null; } catch {}
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        resolve({ status: res.statusCode || 0, data, raw });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Antigravity local request timed out"));
    });
    req.write(body);
    req.end();
  });
}

/**
 * 按优先级从一个端点读取用量快照。
 */
async function fetchSnapshotFromEndpointAsync(endpoint: LocalEndpoint, launched: boolean): Promise<AntigravityUsageSnapshot | null> {
  const attempts: Array<{ path: string; rawSource: AntigravityUsageSnapshot["rawSource"] }> = [
    { path: QUOTA_SUMMARY_PATH, rawSource: "quota-summary" },
    { path: GET_USER_STATUS_PATH, rawSource: "user-status" },
    { path: COMMAND_MODEL_CONFIG_PATH, rawSource: "command-model-configs" },
  ];
  for (const attempt of attempts) {
    try {
      const res = await requestLocalJsonAsync(endpoint, attempt.path);
      const parsed = parseAntigravityUsageResponse(res.data, attempt.rawSource, endpoint.candidate, launched);
      if (parsed && parsed.windows.length > 0) return parsed;
    } catch {}
  }
  return null;
}

/**
 * 从当前已运行的本地服务读取用量。
 */
async function fetchFromRunningLocalServicesAsync(launched = false): Promise<AntigravityUsageSnapshot | null> {
  const candidates = await listProcessCandidatesAsync();
  for (const candidate of candidates) {
    const endpoints = await buildEndpointsForCandidateAsync(candidate);
    for (const endpoint of endpoints) {
      const snapshot = await fetchSnapshotFromEndpointAsync(endpoint, launched);
      if (snapshot) return snapshot;
    }
  }
  return null;
}

/**
 * 解析来源展示类型。
 */
function resolveSnapshotSource(candidate: ProcessCandidate, launched: boolean): AntigravityUsageSnapshot["source"] {
  if (launched) return "launched-agy";
  if (candidate.kind === "app") return "app-local";
  if (candidate.kind === "cli") return "agy-cli";
  if (candidate.kind === "ide") return "ide-local";
  return "local";
}

/**
 * 从 quota summary 响应解析窗口。
 */
function parseQuotaSummaryWindows(data: any): AntigravityUsageWindow[] {
  const groups = Array.isArray(data?.response?.groups)
    ? data.response.groups
    : Array.isArray(data?.groups)
      ? data.groups
      : [];
  const out: AntigravityUsageWindow[] = [];
  for (const group of groups) {
    const groupName = String(group?.displayName || group?.name || "").trim() || null;
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    for (const bucket of buckets) {
      const label = String(bucket?.displayName || bucket?.bucketId || "Quota").trim();
      const remainingPercent = fractionToRemainingPercent(bucket?.remainingFraction ?? bucket?.remaining?.remainingFraction);
      const resetAt = parseResetAtMs(bucket?.resetTime ?? bucket?.remaining?.resetTime);
      const resetText = String(bucket?.description || bucket?.resetDescription || "").trim() || null;
      out.push({
        label,
        groupName,
        bucketId: String(bucket?.bucketId || "").trim() || null,
        remainingPercent,
        usedPercent: usedFromRemainingPercent(remainingPercent),
        resetText,
        resetAt,
        usageKnown: remainingPercent != null,
      });
    }
  }
  return out;
}

/**
 * 从模型配置中解析模型 ID。
 */
function resolveModelId(config: any): string {
  return String(
    config?.modelOrAlias?.model
    || config?.modelOrAlias?.alias
    || config?.model
    || config?.modelId
    || "",
  ).trim();
}

/**
 * 判断模型配置所属的用户可见分组。
 */
function resolveModelGroup(config: any): string {
  const text = `${config?.label || ""} ${resolveModelId(config)}`.toLowerCase();
  if (text.includes("gemini")) return "Gemini";
  if (text.includes("claude") || text.includes("gpt") || text.includes("oss")) return "Claude + GPT";
  return String(config?.label || resolveModelId(config) || "Other").trim();
}

/**
 * 判断模型配置是否适合驱动摘要展示。
 */
function isVisibleQuotaModel(config: any): boolean {
  const text = `${config?.label || ""} ${resolveModelId(config)}`.toLowerCase();
  if (!text.trim()) return false;
  if (text.includes("autocomplete") || text.includes("completion")) return false;
  if (text.includes("image") || text.includes("embedding")) return false;
  if (text.includes("lite")) return false;
  return true;
}

/**
 * 从模型配置列表汇总为用户可见窗口。
 */
function parseModelConfigWindows(configs: any[]): AntigravityUsageWindow[] {
  const grouped = new Map<string, AntigravityUsageWindow>();
  for (const config of configs) {
    const quotaInfo = config?.quotaInfo;
    if (!quotaInfo || !isVisibleQuotaModel(config)) continue;
    const groupName = resolveModelGroup(config);
    const modelId = resolveModelId(config);
    const remainingPercent = fractionToRemainingPercent(quotaInfo?.remainingFraction);
    const resetAt = parseResetAtMs(quotaInfo?.resetTime);
    const current: AntigravityUsageWindow = {
      label: groupName,
      groupName,
      modelId,
      remainingPercent,
      usedPercent: usedFromRemainingPercent(remainingPercent),
      resetAt,
      usageKnown: remainingPercent != null,
    };
    const prev = grouped.get(groupName);
    if (!prev) {
      grouped.set(groupName, current);
      continue;
    }
    if (prev.remainingPercent == null && current.remainingPercent != null) {
      grouped.set(groupName, current);
      continue;
    }
    if (prev.remainingPercent != null && current.remainingPercent != null && current.remainingPercent < prev.remainingPercent) {
      grouped.set(groupName, current);
    }
  }
  return Array.from(grouped.values());
}

/**
 * 从 GetUserStatus 响应解析窗口。
 */
function parseUserStatusWindows(data: any): AntigravityUsageWindow[] {
  const configs = data?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
  return parseModelConfigWindows(Array.isArray(configs) ? configs : []);
}

/**
 * 从 GetCommandModelConfigs 响应解析窗口。
 */
function parseCommandModelConfigWindows(data: any): AntigravityUsageWindow[] {
  const configs = data?.clientModelConfigs || data?.response?.clientModelConfigs;
  return parseModelConfigWindows(Array.isArray(configs) ? configs : []);
}

/**
 * 从 GetUserStatus 响应解析账号邮箱。
 */
function parseAccountEmail(data: any): string | null {
  return String(
    data?.userStatus?.userInfo?.email
    || data?.userStatus?.email
    || data?.userStatus?.profile?.email
    || "",
  ).trim() || null;
}

/**
 * 从 GetUserStatus 响应解析计划名称。
 */
function parsePlanName(data: any): string | null {
  return String(
    data?.userStatus?.planStatus?.planInfo?.planName
    || data?.userStatus?.planInfo?.planName
    || "",
  ).trim() || null;
}

/**
 * 解析 Antigravity 本地接口响应。
 */
export function parseAntigravityUsageResponse(
  data: any,
  rawSource: AntigravityUsageSnapshot["rawSource"],
  candidate?: Partial<ProcessCandidate>,
  launched = false,
): AntigravityUsageSnapshot | null {
  const windows = rawSource === "quota-summary"
    ? parseQuotaSummaryWindows(data)
    : rawSource === "user-status"
      ? parseUserStatusWindows(data)
      : parseCommandModelConfigWindows(data);
  if (windows.length === 0) return null;
  const source = resolveSnapshotSource({
    pid: Number(candidate?.pid || 0),
    kind: candidate?.kind || "unknown",
    commandLine: String(candidate?.commandLine || ""),
  }, launched);
  return {
    providerId: "antigravity",
    source,
    rawSource,
    collectedAt: Date.now(),
    accountEmail: rawSource === "user-status" ? parseAccountEmail(data) : null,
    planName: rawSource === "user-status" ? parsePlanName(data) : null,
    windows,
  };
}

/**
 * 解析环境变量中的 AGY 路径。
 */
function resolveAgyPathFromEnv(): string | null {
  const raw = String(process.env.ANTIGRAVITY_CLI_PATH || process.env.AGY_PATH || "").trim();
  return raw || null;
}

/**
 * 查找 Windows 侧 agy 可执行文件。
 */
async function resolveAgyPathWindowsAsync(): Promise<string | null> {
  const fromEnv = resolveAgyPathFromEnv();
  if (fromEnv) return fromEnv;
  try {
    const stdout = await execFileTextAsync("where.exe", ["agy"], 5000);
    const first = String(stdout || "").split(/\r?\n/).map((x) => x.trim()).find(Boolean);
    if (first) return first;
  } catch {}
  const candidates = [
    path.join(os.homedir(), "AppData", "Local", "Programs", "Antigravity", "resources", "app", "bin", "agy.exe"),
    path.join(os.homedir(), "AppData", "Local", "Google", "Antigravity", "agy.exe"),
  ];
  for (const p of candidates) {
    try {
      const fs = await import("node:fs/promises");
      const st = await fs.stat(p);
      if (st.isFile()) return p;
    } catch {}
  }
  return null;
}

/**
 * 查找 Unix 侧 agy 可执行文件。
 */
async function resolveAgyPathUnixAsync(): Promise<string | null> {
  const fromEnv = resolveAgyPathFromEnv();
  if (fromEnv) return fromEnv;
  try {
    const stdout = await execFileTextAsync("sh", ["-lc", "command -v agy 2>/dev/null || true"], 5000);
    const first = String(stdout || "").split(/\r?\n/).map((x) => x.trim()).find(Boolean);
    if (first) return first;
  } catch {}
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ];
  for (const p of candidates) {
    try {
      const fs = await import("node:fs/promises");
      const st = await fs.stat(p);
      if (st.isFile()) return p;
    } catch {}
  }
  return null;
}

/**
 * 查找 agy 可执行文件。
 */
async function resolveAgyPathAsync(): Promise<string | null> {
  return os.platform() === "win32" ? resolveAgyPathWindowsAsync() : resolveAgyPathUnixAsync();
}

/**
 * 判断 warm agy 会话是否仍可复用。
 */
function isWarmAgySessionAlive(): boolean {
  return !!warmAgySession && !!warmAgySession.proc;
}

/**
 * 解析 PTY 启动 agy 时使用的命令与参数。
 */
function resolveAgyPtyCommand(agyPath: string): { file: string; args: string[]; executable: string } {
  const normalized = String(agyPath || "").trim();
  if (os.platform() === "win32" && /\.(cmd|bat)$/i.test(normalized))
    return { file: "cmd.exe", args: ["/d", "/c", "call", normalized], executable: normalized };
  return { file: normalized, args: [], executable: normalized };
}

/**
 * 安排关闭 CodexFlow 自己启动的 agy。
 */
function scheduleWarmAgyShutdown(): void {
  if (!warmAgySession) return;
  warmAgySession.lastUsedAt = Date.now();
  if (warmAgySession.killTimer) {
    clearTimeout(warmAgySession.killTimer);
    warmAgySession.killTimer = null;
  }
  warmAgySession.killTimer = setTimeout(() => {
    const session = warmAgySession;
    if (!session) return;
    if (Date.now() - session.lastUsedAt < AGY_WARM_IDLE_MS - 1000) {
      scheduleWarmAgyShutdown();
      return;
    }
    try { session.proc.kill(); } catch {}
    warmAgySession = null;
  }, AGY_WARM_IDLE_MS);
}

/**
 * 确保存在一个由 CodexFlow 启动的 agy PTY 会话。
 */
async function ensureAgyWarmSessionAsync(): Promise<void> {
  if (isWarmAgySessionAlive()) {
    scheduleWarmAgyShutdown();
    return;
  }
  const agyPath = await resolveAgyPathAsync();
  if (!agyPath) throw new Error("ANTIGRAVITY_CLI_NOT_FOUND");

  const env = { ...process.env };
  const cwd = os.homedir();
  const launch = resolveAgyPtyCommand(agyPath);
  const proc = pty.spawn(launch.file, launch.args, {
    name: "xterm-color",
    cols: 80,
    rows: 24,
    cwd,
    env,
  });
  proc.onData(() => {});
  proc.onExit(() => {
    if (warmAgySession?.proc === proc) warmAgySession = null;
  });
  warmAgySession = {
    proc,
    pid: typeof proc.pid === "number" ? proc.pid : null,
    executable: launch.executable,
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
    killTimer: null,
  };
  scheduleWarmAgyShutdown();
}

/**
 * 等待临时启动的 agy 本地额度服务就绪。
 */
async function waitForLaunchedAgySnapshotAsync(): Promise<AntigravityUsageSnapshot | null> {
  const deadline = Date.now() + AGY_READY_TIMEOUT_MS;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const snapshot = await fetchFromRunningLocalServicesAsync(true);
      if (snapshot) return snapshot;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  if (lastError) {
    try { perfLogger.log(`[antigravity.usage] launched agy probe failed: ${String(lastError)}`); } catch {}
  }
  return null;
}

/**
 * 获取 Antigravity 用量快照：先复用本地服务，失败后临时启动 agy。
 */
export async function getAntigravityUsageSnapshotAsync(): Promise<AntigravityUsageSnapshot> {
  return perfLogger.time("[antigravity] usage snapshot", async () => {
    const local = await fetchFromRunningLocalServicesAsync(false);
    if (local) return local;

    await ensureAgyWarmSessionAsync();
    const launched = await waitForLaunchedAgySnapshotAsync();
    if (launched) {
      scheduleWarmAgyShutdown();
      return launched;
    }
    throw new Error("ANTIGRAVITY_LOCAL_SERVICE_NOT_FOUND");
  });
}

export const __antigravityUsageTest = {
  buildEndpointsForCandidate,
  fractionToRemainingPercent,
  parseQuotaSummaryWindows,
  parseModelConfigWindows,
  resolveAgyPtyCommand,
  resolveModelGroup,
  toProcessCandidate,
};
