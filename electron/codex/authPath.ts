// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import os from "node:os";
import path from "node:path";
import { execInWslAsync } from "../wsl";
import type { CodexBridgeOptions } from "./bridge";

/** 按引擎环境定位认证文件，兼容自定义主目录和默认 WSL 发行版。 */
export async function resolveCodexAuthJsonPathAsync(runtime: { key: string; options: CodexBridgeOptions }): Promise<{ ok: true; authJsonPath: string } | { ok: false; error: string }> {
  try {
    const mode = runtime?.options?.mode ?? "native";
    if (mode === "wsl" && os.platform() === "win32") {
      const distro = String(runtime?.options?.wslDistro || "").trim();
      const codexUNC = (await execInWslAsync(distro || undefined, 'wslpath -w "${CODEX_HOME:-$HOME/.codex}"', { timeoutMs: 5000 }))?.trim();
      if (!codexUNC) return { ok: false, error: "无法定位 WSL 的 CODEX_HOME" };
      return { ok: true, authJsonPath: path.join(codexUNC, "auth.json") };
    }
    const codexHome = String(process.env.CODEX_HOME || "").trim() || path.join(os.homedir(), ".codex");
    return { ok: true, authJsonPath: path.join(codexHome, "auth.json") };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
