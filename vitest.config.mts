/// <reference types="vitest" />

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "web/src"),
      // 单测环境不依赖 Electron 二进制（避免 `electron` 包未下载导致的运行失败）
      "electron": path.resolve(__dirname, "electron/__mocks__/electron.ts"),
    },
  },
});
