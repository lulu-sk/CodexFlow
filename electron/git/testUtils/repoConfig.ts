// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { promises as fsp } from "node:fs";
import path from "node:path";

type FixtureGitRunner = (repoRoot: string, argv: string[]) => Promise<unknown>;

/** 仅为独立测试仓库批量写入初始配置；已有配置、工作区和复杂取值仍交由 Git 处理。 */
export async function configureGitFixtureAsync(
  repoRoot: string,
  settings: Array<[string, string]>,
  runGit: FixtureGitRunner,
): Promise<void> {
  if (!settings.length) return;
  const gitDir = path.join(repoRoot, ".git");
  try {
    const configPath = path.join(gitDir, "config");
    if ((await fsp.lstat(gitDir)).isDirectory() && (await fsp.lstat(configPath)).isFile()) {
      const existing = await fsp.readFile(configPath, "utf8");
      // Git 允许节名与键同行，也允许布尔键省略等号；已有配置仍交由 Git 更新。
      const hasSpecialConfig = /(?:^|\n)\s*\[include|(?:^|\n|\])\s*(?:name|email|autocrlf|eol)\b/i.test(existing);
      const isKnownSetting = settings.every(([key, value]) => (
        /^(?:user\.(?:name|email)|core\.(?:autocrlf|eol))$/.test(key) && /^[a-zA-Z0-9@._-]+$/.test(value)
      ));
      const hasUniqueKeys = new Set(settings.map(([key]) => key)).size === settings.length;
      if (!hasSpecialConfig && isKnownSetting && hasUniqueKeys) {
        const lines = settings.map(([key, value]) => {
          const [section, name] = key.split(".");
          return `[${section}]\n\t${name} = ${value}\n`;
        });
        await fsp.appendFile(configPath, `\n${lines.join("")}`, "utf8");
        return;
      }
    }
  } catch {
    // 特殊布局或文件访问异常时，保留原命令的配置语义与错误。
  }
  for (const [key, value] of settings) await runGit(repoRoot, ["config", key, value]);
}
