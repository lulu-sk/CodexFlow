// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk)

const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const repoRoot = path.resolve(__dirname, "..");

/**
 * 将仓库相对路径解析为绝对路径。
 */
function resolveRepoPath(relativePath) {
  return path.join(repoRoot, relativePath);
}

/**
 * 判断文件是否存在且是普通文件。
 */
function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * 断言仓库内文件存在。
 */
function requireRepoFile(relativePath, label) {
  const filePath = resolveRepoPath(relativePath);
  if (isFile(filePath)) {
    console.log(`[release-check] ${label}: ${relativePath}`);
    return;
  }
  throw new Error(`${label} 缺失：${relativePath}`);
}

/**
 * 断言 app.asar 内包含指定文件。
 */
function requireAsarFile(archivePath, archiveFilePath, label) {
  try {
    const content = asar.extractFile(archivePath, archiveFilePath);
    if (content && content.length > 0) {
      console.log(`[release-check] ${label}: app.asar/${archiveFilePath}`);
      return;
    }
  } catch {}
  throw new Error(`${label} 未打入 app.asar：${archiveFilePath}`);
}

/**
 * 校验 electron-builder 打包输入产物。
 */
function checkBeforePack() {
  requireRepoFile("dist/electron/main.js", "主进程入口");
  requireRepoFile("dist/electron/preload.js", "预加载脚本");
  requireRepoFile("web/dist/index.html", "前端入口");
}

/**
 * 校验绿色版输出产物。
 */
function checkAfterPack() {
  const archivePath = resolveRepoPath("dist/win-unpacked/resources/app.asar");
  requireRepoFile("dist/win-unpacked/CodexFlow.exe", "绿色版可执行文件");
  requireRepoFile("dist/win-unpacked/resources/app.asar", "应用归档");
  requireAsarFile(archivePath, "dist\\electron\\main.js", "主进程入口");
  requireAsarFile(archivePath, "dist\\electron\\preload.js", "预加载脚本");
  requireAsarFile(archivePath, "web\\dist\\index.html", "前端入口");
}

/**
 * 执行指定阶段的产物校验。
 */
function main() {
  const phase = String(process.argv[2] || "before-pack").trim();
  if (phase === "before-pack") {
    checkBeforePack();
    return;
  }
  if (phase === "after-pack") {
    checkAfterPack();
    return;
  }
  throw new Error(`未知校验阶段：${phase}`);
}

try {
  main();
} catch (error) {
  console.error(`[release-check] ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
}
