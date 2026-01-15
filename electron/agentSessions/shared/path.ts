// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import path from "node:path";
import { isUNCPath, uncToWsl } from "../../wsl";

/**
 * 清理从日志/JSON 中提取的路径候选：
 * - 去除首尾空白与包裹引号
 * - 折叠 JSON 转义反斜杠（例如 C:\\code -> C:\code）
 * - 去除尾部分隔符
 */
export function tidyPathCandidate(value: string): string {
  try {
    let s = String(value || "")
      .replace(/\\n/g, "")
      .replace(/^"|"$/g, "")
      .replace(/^'|'$/g, "")
      .trim();
    s = s.replace(/\\\\/g, "\\").trim();
    s = s.replace(/[\\/]+$/g, "");
    return s;
  } catch {
    return String(value || "").trim();
  }
}

/**
 * 从文件路径获取用于项目归属匹配的 dirKey（优先归一为 WSL 风格）。
 */
export function dirKeyOfFilePath(filePath: string): string {
  try {
    const d = path.dirname(filePath);
    const s = d.replace(/\\/g, "/").replace(/\/+/g, "/");
    const m = s.match(/^([a-zA-Z]):\/(.*)$/);
    if (m) return (`/mnt/${m[1].toLowerCase()}/${m[2]}`).replace(/\/+/g, "/").replace(/\/+$/, "").toLowerCase();
    if (isUNCPath(d)) {
      const info = uncToWsl(d);
      if (info) return info.wslPath.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "").toLowerCase();
    }
    return s.replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(filePath || "").replace(/\\/g, "/").toLowerCase();
  }
}

/**
 * 从 cwd/项目路径计算用于匹配的 dirKey（不降一级目录）。
 */
export function dirKeyFromCwd(dirPath: string): string {
  try {
    let d = tidyPathCandidate(dirPath);
    if (isUNCPath(d)) {
      const info = uncToWsl(d);
      if (info) d = info.wslPath;
    } else {
      const m = d.match(/^([a-zA-Z]):\\(.*)$/);
      if (m) d = `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
    }
    return d.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(dirPath || "").replace(/\\/g, "/").toLowerCase();
  }
}

