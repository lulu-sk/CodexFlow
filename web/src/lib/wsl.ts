// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

// 仅用于“插入时”的同步字符串转换/拼接（不访问文件系统）

// Windows 绝对路径或 UNC 到 WSL 插入文本的转换：
// - C:\a\b\c.txt -> /mnt/c/a/b/c.txt（盘符小写，\\->/）
// - \\wsl$\Ubuntu-22.04\home\me\p\q -> /home/me/p/q
// - \\wsl$\Ubuntu-22.04\mnt\c\a\b -> /mnt/c/a/b
// - 已是 /mnt/x/...、/home/...、/usr/... -> 原样
// - 其他 UNC（非 \\wsl$ / \\wsl.localhost）-> 仅替换分隔符
export function toWSLForInsert(absPath: string): string {
  try {
    let s = String(absPath || "");
    // 兼容 file: 开头的路径输入，转换为 Windows/UNC 再统一处理
    if (/^file:/i.test(s)) {
      try {
        let rest = s.slice(5); // 去掉 file:
        rest = rest.replace(/^[\\/]+/, "");
        if (/^[a-zA-Z]:/.test(rest)) {
          // 驱动器路径
          s = rest.replace(/\//g, "\\");
        } else if (rest) {
          // UNC 主机名
          s = "\\\\" + rest.replace(/\//g, "\\");
        }
      } catch { /* ignore */ }
    }
    // 已是 POSIX 常见前缀
    if (/^\/(mnt|home|usr)\//i.test(s)) return s;
    // UNC -> 处理 wsl$ 或 wsl.localhost
    if (/^\\\\/i.test(s)) {
      const lower = s.toLowerCase();
      const wslPrefix1 = "\\\\wsl$\\"; // 历史样式
      const wslPrefix2 = "\\\\wsl.localhost\\"; // 新样式
      if (lower.startsWith(wslPrefix1) || lower.startsWith(wslPrefix2)) {
        // 去掉前缀与发行版名：\\wsl$\Distro\... 或 \\wsl.localhost\Distro\...
        const body = s.replace(/^\\\\wsl(\.localhost)?\\/i, "");
        // 去掉发行版名（到下一个反斜杠）
        const stripped = body.replace(/^[^\\/]+[\\/]/, "");
        return ("/" + stripped).replace(/\\/g, "/");
      }
      // 其他 UNC：仅标准化分隔符
      return s.replace(/\\/g, "/");
    }
    // Windows 盘符：C:\...
    const m = s.match(/^([a-zA-Z]):\\(.*)$/);
    if (m) {
      const drive = m[1].toLowerCase();
      const rest = m[2].replace(/\\/g, "/");
      return `/mnt/${drive}/${rest}`;
    }
    // 兜底：仅做分隔符标准化
    return s.replace(/\\/g, "/");
  } catch { return String(absPath || ""); }
}

// Windows 风格拼接（根必为绝对 Windows 路径或 UNC），子路径为相对（使用 / 或 \\ 均可）
export function joinWinAbs(root: string, rel: string): string {
  const r = String(root || "").replace(/\/?$/, "");
  const child = String(rel || "").replace(/^\/+/, "").replace(/\\/g, "\\").replace(/\//g, "\\");
  // 若根为 UNC，保持 \\ 分隔；若为盘符路径，也使用 \\ 分隔
  return r + (child ? (r.endsWith("\\") ? "" : "\\") + child : "");
}

/**
 * 将 Windows 绝对路径转换为“项目内相对 WSL 路径或 WSL 绝对路径”。
 * - 若 winPath 在 projectWinRoot 内：返回相对 WSL 路径（不以 / 开头，使用 / 分隔）
 * - 否则：返回可直接插入文本的 WSL 绝对路径（/mnt/... 或 /home/... 等）
 */
export function toWslRelOrAbsForProject(winPath: string, projectWinRoot?: string, style: 'absolute' | 'relative' = 'relative'): string {
  try {
    const wp = String(winPath || "");
    const root = String(projectWinRoot || "").trim();
    if (root) {
      const a = wp.replace(/\//g, "\\");
      const r = root.replace(/\//g, "\\");
      const al = a.toLowerCase();
      const rl = r.toLowerCase();
      const isInProject = (al === rl) || al.startsWith(rl + "\\");
      if (isInProject) {
        if (style === 'relative') {
          if (al === rl) return ".";
          const rel = a.slice(r.length).replace(/^\\+/, "").replace(/\\/g, "/");
          return rel || ".";
        } else {
          // 绝对路径：直接转为 WSL 绝对路径
          return toWSLForInsert(wp);
        }
      }
    }
    return toWSLForInsert(wp);
  } catch {
    return toWSLForInsert(String(winPath || ""));
  }
}
