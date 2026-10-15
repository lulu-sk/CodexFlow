// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

type WindowsEnvironmentSnapshot = {
  machine: NodeJS.ProcessEnv;
  user: NodeJS.ProcessEnv;
};

let pendingEnvironment: Promise<WindowsEnvironmentSnapshot | null> | null = null;

/**
 * 只读查询系统与用户当前的环境变量，并合并同时发生的查询。
 * 查询结果只在内存中用于创建子进程，不写入文件或日志。
 */
function readWindowsEnvironment(): Promise<WindowsEnvironmentSnapshot | null> {
  if (pendingEnvironment) return pendingEnvironment;
  const shell = path.win32.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
  const script = [
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding",
    "$values = @{ machine = [Environment]::GetEnvironmentVariables('Machine'); user = [Environment]::GetEnvironmentVariables('User') }",
    "ConvertTo-Json -InputObject $values -Depth 3 -Compress",
  ].join("; ");
  pendingEnvironment = new Promise<WindowsEnvironmentSnapshot | null>((resolve) => {
    execFile(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const values = JSON.parse(stdout.replace(/^\uFEFF/, ""));
        if (!values || typeof values !== "object" || Array.isArray(values)) return resolve(null);
        for (const scope of [values.machine, values.user]) {
          if (!scope || typeof scope !== "object" || Array.isArray(scope)) return resolve(null);
        }
        resolve(values);
      } catch {
        resolve(null);
      }
    });
  }).finally(() => { pendingEnvironment = null; });
  return pendingEnvironment;
}

/**
 * 保留父进程中已有的普通变量及空值，仅为缺失项补入用户或系统配置。
 * 补入时用户变量优先；PATH 仅追加缺失目录，显式空 PATH 保持不变。
 * 调用方应在此后应用会话覆盖；自动补齐属于终端宿主的兼容处理。
 * 查询失败沿用原环境，不修改主进程或注册表。
 */
export async function refreshWindowsEnvironment(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (os.platform() !== "win32") return env;
  const snapshot = await readWindowsEnvironment();
  if (!snapshot) return env;
  const next = { ...env };
  const names = new Map<string, string>();
  // 与 Node 的 Windows 子进程规则一致，大小写重复时保留排序后的第一个变量。
  for (const key of Object.keys(next).sort()) {
    if (typeof next[key] !== "string") {
      delete next[key];
      continue;
    }
    const name = key.toLowerCase();
    if (names.has(name)) delete next[key];
    else names.set(name, key);
  }
  const inheritedNames = new Set(names.keys());
  const paths: string[] = [];
  for (const scope of [snapshot.machine, snapshot.user]) {
    for (const [key, value] of Object.entries(scope)) {
      if (!key || typeof value !== "string") continue;
      const name = key.toLowerCase();
      if (name === "path") {
        paths.push(value);
        continue;
      }
      if (inheritedNames.has(name)) continue;
      const target = names.get(name) || key;
      names.set(name, target);
      next[target] = value;
    }
  }
  const pathKey = names.get("path") || "Path";
  const current = next[pathKey] || "";
  if (inheritedNames.has("path") && current === "") return next;
  const seen = new Set<string>();
  const additions: string[] = [];
  for (const [index, value] of [current, ...paths].entries()) {
    for (const entry of value.split(";")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const key = path.win32.normalize(trimmed.replace(/^"(.*)"$/, "$1")).replace(/[\\/]+$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (index > 0) additions.push(trimmed);
    }
  }
  if (additions.length > 0)
    next[pathKey] = [current, ...additions].filter(Boolean).join(";");
  return next;
}
