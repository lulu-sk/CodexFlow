// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

const fs = require("node:fs/promises");
const path = require("node:path");

const KEEP_LOCALES = new Set(["en-US", "zh-CN"]);

async function pruneLocales(localesDir) {
  try {
    const entries = await fs.readdir(localesDir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) {
          return;
        }
        const match = entry.name.match(/^(.+)\.pak$/);
        if (!match) {
          return;
        }
        const locale = match[1];
        if (KEEP_LOCALES.has(locale)) {
          return;
        }
        const target = path.join(localesDir, entry.name);
        await fs.unlink(target);
      })
    );
    const leftLocales = await fs.readdir(localesDir);
    if (leftLocales.length === 0) {
      await fs.rm(localesDir, { force: true, recursive: true });
    }
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

/** @param {import("electron-builder").AfterPackContext} context 打包后钩子提供上下文 */
exports.default = async function afterPack(context) {
  const localesRoot = path.join(context.appOutDir, "locales");
  const resourcesLocales = path.join(context.appOutDir, "resources", "locales");
  await pruneLocales(localesRoot);
  await pruneLocales(resourcesLocales);
};
