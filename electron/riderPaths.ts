// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk/CodexFlow)

import path from "node:path";

const RIDER_EXECUTABLE_NAMES = ["rider64.exe", "rider.exe"] as const;

export type RiderExecutableCandidateOptions = {
  /** 允许测试时覆盖平台值。 */
  platform?: NodeJS.Platform;
  /** PATH 中的目录列表。 */
  pathEntries?: readonly string[];
  /** Windows 卸载注册表中的 Rider 安装目录或可执行文件路径。 */
  registryInstallLocations?: readonly string[];
  /** 展开注册表路径所使用的环境变量。 */
  environment?: Readonly<NodeJS.ProcessEnv>;
};

/**
 * 清理 Windows 路径两端的空白与成对双引号。
 */
function normalizeWindowsPathInput(raw: string): string {
  let value = String(raw || "").trim();
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\""))
    value = value.slice(1, -1).trim();
  return value;
}

/**
 * 展开 REG_EXPAND_SZ 等路径中的 Windows 环境变量占位符。
 * 未定义的变量保持原样，避免把路径静默改成错误位置。
 */
function expandWindowsEnvironmentVariables(
  value: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  const values = new Map<string, string>();
  for (const [name, rawValue] of Object.entries(environment)) {
    if (typeof rawValue !== "string") continue;
    values.set(name.toLowerCase(), rawValue);
  }
  return value.replace(/%([^%]+)%/g, (token, name: string) => values.get(name.toLowerCase()) ?? token);
}

/**
 * 解析 Windows `reg query ... /s /v InstallLocation` 输出中的 Rider 安装目录。
 * 仅接受注册表项名称或安装目录明确包含 Rider 的块，避免把其他软件目录误当成 IDE。
 */
export function parseRiderRegistryInstallLocations(raw: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  /**
   * 追加去重后的注册表安装位置。
   */
  const append = (value: string) => {
    const normalized = normalizeWindowsPathInput(value).replace(/[\\/]+$/, "");
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(normalized);
  };

  const blocks = String(raw || "").split(/(?=^HKEY_[^\r\n]*(?:\r?\n|$))/im);
  for (const block of blocks) {
    const header = block.match(/^HKEY_[^\r\n]*/im)?.[0] || "";
    const installLocation = block.match(/^\s*InstallLocation\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/im)?.[1] || "";
    if (!installLocation) continue;
    if (!/rider/i.test(header) && !/rider/i.test(installLocation)) continue;
    append(installLocation);
  }
  return result;
}

/**
 * 根据 PATH 和注册表安装目录构造 Rider 可执行文件候选列表。
 * 不生成 `Rider.cmd` 等 Toolbox 启动脚本，避免脚本内部仍指向已卸载版本。
 */
export function buildRiderExecutableCandidates(options: RiderExecutableCandidateOptions = {}): string[] {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return [];

  const candidates: string[] = [];
  const seen = new Set<string>();
  const environment = options.environment || process.env;
  /**
   * 追加去重后的可执行文件候选路径。
   */
  const append = (value: string) => {
    const normalized = normalizeWindowsPathInput(value);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(normalized);
  };
  /**
   * 将安装目录或直接的 exe 路径转换为 Rider 可执行文件候选。
   */
  const appendFromLocation = (rawLocation: string) => {
    const location = expandWindowsEnvironmentVariables(
      normalizeWindowsPathInput(rawLocation),
      environment,
    );
    if (!location) return;
    if (/\.exe$/i.test(location)) {
      append(location);
      return;
    }
    const normalizedLocation = location.replace(/[\\/]+$/, "");
    const binLocation = /[\\/]bin$/i.test(normalizedLocation)
      ? normalizedLocation
      : path.win32.join(normalizedLocation, "bin");
    for (const executable of RIDER_EXECUTABLE_NAMES)
      append(path.win32.join(binLocation, executable));
  };

  for (const entry of options.pathEntries || []) {
    const directory = expandWindowsEnvironmentVariables(
      normalizeWindowsPathInput(entry),
      environment,
    );
    if (!directory) continue;
    for (const executable of RIDER_EXECUTABLE_NAMES)
      append(path.win32.join(directory, executable));
  }
  for (const location of options.registryInstallLocations || []) appendFromLocation(location);
  return candidates;
}
