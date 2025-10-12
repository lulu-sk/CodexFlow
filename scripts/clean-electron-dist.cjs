// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

// 清理 dist/electron 目录，避免遗留旧文件影响打包。
const fs = require("node:fs");
const path = require("node:path");

const outDir = path.resolve(__dirname, "..", "dist", "electron");

try {
  fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 3 });
} catch (error) {
  console.warn(`[clean-electron-dist] 无法删除 ${outDir}: ${error instanceof Error ? error.message : String(error)}`);
}
