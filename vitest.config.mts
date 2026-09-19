/// <reference types="vitest" />

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // 真实 Git 集成测试并发会放大进程启动开销，单进程保留原超时下的执行余量。
    minWorkers: 1,
    maxWorkers: 1,
    exclude: [...configDefaults.exclude, "**/.tmp/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "web/src"),
      // 单测环境不依赖 Electron 二进制（避免 `electron` 包未下载导致的运行失败）
      "electron": path.resolve(__dirname, "electron/__mocks__/electron.ts"),
    },
  },
});
