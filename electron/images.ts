// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeImage, clipboard, app } from "electron";
import wsl from "./wsl";

// 图片工具：负责保存渲染层传入的数据（DataURL/Buffer）到稳定目录，并返回 Windows 与 WSL 双路径

type SaveOpts = {
  // 目标项目 Windows 根路径（若提供，则写入其子目录 .codexflow-assets）
  projectWinRoot?: string;
  // 目标项目名称（用于应用级固定缓存目录的分组）
  projectName?: string;
  // 建议的扩展名（不含 .），默认为 png
  ext?: string;
  // 文件名前缀，默认 image
  prefix?: string;
};

function ensureDirSync(dir: string) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function safeProjectKey(name?: string): string {
  const raw = String(name || "").trim();
  if (!raw) return "default";
  // 将不安全字符替换为下划线，避免生成非法路径
  return raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "-");
}

function getAssetsRoot(projectWinRoot?: string, projectName?: string): { winRoot: string; subDir: string } {
  // 新默认：存放在应用固定目录下（按项目名分组），而非项目目录；取消日期分层
  // 使用 Electron userData 路径，确保随应用隔离且可清理
  const userData = (() => {
    try { return app.getPath("userData"); } catch { return path.join(os.homedir(), ".codexflow"); }
  })();
  const projKey = safeProjectKey(projectName || (projectWinRoot ? path.basename(projectWinRoot) : ""));
  const base = path.join(userData, "assets", projKey);
  return { winRoot: base, subDir: base };
}

function sanitizeExt(ext?: string): string {
  const e = String(ext || "png").toLowerCase().replace(/^\.+/, "");
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(e)) return e;
  return "png";
}

function pickExtFromMime(mime?: string): string {
  const m = String(mime || "");
  if (/png/i.test(m)) return "png";
  if (/jpe?g/i.test(m)) return "jpg";
  if (/webp/i.test(m)) return "webp";
  if (/gif/i.test(m)) return "gif";
  if (/bmp/i.test(m)) return "bmp";
  return "png";
}

function genFileName(prefix?: string, ext?: string): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const stamp = `${yyyy}${MM}${dd}-${HH}${mm}${ss}`;
  const rnd = Math.random().toString(36).slice(2, 6);
  const p = (prefix && prefix.trim()) ? prefix.trim() : "image";
  const e = sanitizeExt(ext);
  return `${p}-${stamp}-${rnd}.${e}`;
}

async function writeFileAtomic(p: string, buf: Buffer): Promise<void> {
  const tmp = p + ".tmp-" + Math.random().toString(36).slice(2, 8);
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, p);
}

export async function saveFromBuffer(buf: Buffer, opts: SaveOpts = {}): Promise<{ ok: true; winPath: string; wslPath: string; fileName: string } | { ok: false; error: string }> {
  try {
    const { projectWinRoot, projectName, ext, prefix } = opts;
    const { subDir } = getAssetsRoot(projectWinRoot, projectName);
    ensureDirSync(subDir);
    const fileName = genFileName(prefix, ext);
    const winPath = path.join(subDir, fileName);
    await writeFileAtomic(winPath, buf);
    // 返回 WSL 路径（用于插入文本）
    const wslPath = wsl.winToWsl(winPath, (require("./settings") as any).default?.getSettings?.().distro || "Ubuntu-24.04");
    return { ok: true, winPath, wslPath, fileName };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
}

export async function saveFromDataURL(dataURL: string, opts: SaveOpts & { mimeHint?: string } = {}): Promise<{ ok: true; winPath: string; wslPath: string; fileName: string } | { ok: false; error: string }> {
  try {
    if (!dataURL || typeof dataURL !== "string") return { ok: false, error: "invalid dataURL" } as any;
    const m = dataURL.match(/^data:([^;,]+);base64,(.*)$/i);
    if (!m) return { ok: false, error: "unsupported dataURL" } as any;
    const mime = m[1] || opts.mimeHint || "image/png";
    const b64 = m[2];
    const buf = Buffer.from(b64, "base64");
    const ext = sanitizeExt(opts.ext || pickExtFromMime(mime));
    return await saveFromBuffer(buf, { projectWinRoot: opts.projectWinRoot, projectName: opts.projectName, ext, prefix: opts.prefix });
  } catch (e: any) {
    return { ok: false, error: String(e) } as any;
  }
}

export function clipboardHasImage(): boolean {
  try { return !clipboard.readImage().isEmpty(); } catch { return false; }
}

export async function readClipboardAsPNGAndSave(opts: SaveOpts = {}) {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return { ok: false, error: "clipboard has no image" } as const;
    // 统一为 PNG 存储（通用、无损）
    const png = img.toPNG();
    return await saveFromBuffer(Buffer.isBuffer(png) ? png : Buffer.from(png), { ...opts, ext: "png" });
  } catch (e: any) {
    return { ok: false, error: String(e) } as const;
  }
}

export default {
  saveFromBuffer,
  saveFromDataURL,
  clipboardHasImage,
  readClipboardAsPNGAndSave,
};
