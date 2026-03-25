// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { nativeImage, clipboard, app } from "electron";
import wsl from "./wsl";
import { resolveGeminiImageDirWinPath, type GeminiRuntimeEnv } from "./gemini/projectTemp";

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
  // 目标项目的 WSL 根路径（Gemini+WSL 时用于解析 Gemini shortId）
  projectWslRoot?: string;
  // Provider 标识，仅在 Gemini 时启用专用目录策略
  providerId?: string;
  // 当前 Provider 的运行环境
  runtimeEnv?: GeminiRuntimeEnv;
  // WSL 发行版名称（仅 runtimeEnv=wsl 且 provider=gemini 时需要）
  distro?: string;
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

/**
 * 中文说明：判断当前保存请求是否需要走 Gemini 专用图片临时目录。
 */
function shouldUseGeminiImageDir(opts: SaveOpts): boolean {
  return String(opts.providerId || "").trim().toLowerCase() === "gemini";
}

/**
 * 中文说明：读取当前设置中的默认 WSL 发行版名称。
 */
function resolveDefaultDistro(): string {
  try {
    const settingsMod = require("./settings") as any;
    return String(settingsMod?.default?.getSettings?.().distro || "Ubuntu-24.04").trim() || "Ubuntu-24.04";
  } catch {
    return "Ubuntu-24.04";
  }
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

/**
 * 中文说明：解析当前图片保存根目录；仅 Gemini 使用 `~/.gemini/tmp/<projectId>/images`。
 */
async function resolveImageSaveRoot(opts: SaveOpts): Promise<{ winRoot: string; subDir: string }> {
  if (shouldUseGeminiImageDir(opts)) {
    const runtimeEnv = opts.runtimeEnv || "windows";
    const distro = String(opts.distro || "").trim() || resolveDefaultDistro();
    const geminiDir = await resolveGeminiImageDirWinPath({
      projectWinRoot: opts.projectWinRoot,
      projectWslRoot: opts.projectWslRoot,
      runtimeEnv,
      distro,
    });
    if (geminiDir) {
      return { winRoot: geminiDir, subDir: geminiDir };
    }
  }
  return getAssetsRoot(opts.projectWinRoot, opts.projectName);
}

function sanitizeExt(ext?: string): string {
  const e = String(ext || "png").toLowerCase().replace(/^\.+/, "");
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(e)) return e;
  return "png";
}

/**
 * 中文说明：根据文件路径扩展名推断图片 MIME，用于生成 `data:` 预览地址。
 */
function inferImageMimeTypeFromFilePath(filePath?: string): string {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  return "image/png";
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
    const { ext, prefix } = opts;
    const { subDir } = await resolveImageSaveRoot(opts);
    ensureDirSync(subDir);
    const fileName = genFileName(prefix, ext);
    const winPath = path.join(subDir, fileName);
    await writeFileAtomic(winPath, buf);
    // 返回 WSL 路径（用于插入文本）
    const wslPath = wsl.winToWsl(winPath, String(opts.distro || "").trim() || resolveDefaultDistro());
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
    return await saveFromBuffer(buf, {
      projectWinRoot: opts.projectWinRoot,
      projectName: opts.projectName,
      projectWslRoot: opts.projectWslRoot,
      providerId: opts.providerId,
      runtimeEnv: opts.runtimeEnv,
      distro: opts.distro,
      ext,
      prefix: opts.prefix,
    });
  } catch (e: any) {
    return { ok: false, error: String(e) } as any;
  }
}

export function clipboardHasImage(): boolean {
  try { return !clipboard.readImage().isEmpty(); } catch { return false; }
}

/**
 * 中文说明：把图片来源字符串规范化为主进程可读取的本地文件路径。
 * - 兼容 `file:///`、Windows 盘符、UNC、`/mnt/<drive>/...` 与 WSL 绝对路径；
 * - 返回空串表示该来源不是本地文件路径或无法可靠映射。
 */
export function normalizeImageSourceToFilePath(value?: string): string {
  try {
    let raw = String(value || "").trim();
    if (!raw || /^data:image\//i.test(raw)) return "";

    if (/^file:\/\//i.test(raw)) {
      try {
        const parsed = new URL(raw);
        const decodedPath = decodeURIComponent(parsed.pathname || "");
        if (parsed.host) {
          raw = `\\\\${parsed.host}${decodedPath.replace(/\//g, "\\")}`;
        } else if (/^\/[A-Za-z]:\//.test(decodedPath)) {
          raw = decodedPath.slice(1).replace(/\//g, "\\");
        } else {
          raw = decodedPath;
        }
      } catch {
        raw = raw.replace(/^file:\/\//i, "");
      }
    }

    const mntMatch = raw.match(/^\/mnt\/([A-Za-z])\/(.*)$/);
    if (mntMatch?.[1]) {
      const drive = mntMatch[1].toUpperCase();
      const rest = String(mntMatch[2] || "").replace(/\//g, "\\");
      return `${drive}:\\${rest}`;
    }

    if (raw.startsWith("/")) {
      try { return wsl.wslToUNC(raw, resolveDefaultDistro()); } catch {}
      return "";
    }

    return wsl.normalizeWinPath(raw);
  } catch {
    return "";
  }
}

/**
 * 中文说明：将本地图片来源物化为 `data:` URL，供开发态 `http://` 渲染进程安全预览。
 * - 非本地图片来源直接原样返回；
 * - 本地图片会先解析为文件路径，再读取字节并编码为 `data:` URL。
 */
export async function materializeImagePreviewURL(value?: string): Promise<{ ok: true; src: string; mimeType?: string } | { ok: false; error: string }> {
  try {
    const raw = String(value || "").trim();
    if (!raw) return { ok: true, src: "" };
    if (/^(?:data:image\/|blob:|https?:)/i.test(raw)) return { ok: true, src: raw };

    const filePath = normalizeImageSourceToFilePath(raw);
    if (!filePath) return { ok: true, src: raw };

    const buffer = await fsp.readFile(filePath);
    const mimeType = inferImageMimeTypeFromFilePath(filePath);
    return {
      ok: true,
      src: `data:${mimeType};base64,${buffer.toString("base64")}`,
      mimeType,
    };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
}

/**
 * 中文说明：从多种图片来源中构造 Electron `nativeImage`，供剪贴板复制等原生能力复用。
 */
function createNativeImageFromSources(args: { localPath?: string; src?: string; fallbackSrc?: string }): Electron.NativeImage | null {
  const sources = [args.localPath, args.src, args.fallbackSrc];
  for (const source of sources) {
    const raw = String(source || "").trim();
    if (!raw) continue;
    try {
      if (/^data:image\//i.test(raw)) {
        const image = nativeImage.createFromDataURL(raw);
        if (image && !image.isEmpty()) return image;
        continue;
      }
      const filePath = normalizeImageSourceToFilePath(raw);
      if (!filePath) continue;
      const image = nativeImage.createFromPath(filePath);
      if (image && !image.isEmpty()) return image;
    } catch {}
  }
  return null;
}

/**
 * 中文说明：将指定图片写入系统剪贴板，兼容本地路径与 data URL。
 */
export async function copyImageToClipboard(args: { localPath?: string; src?: string; fallbackSrc?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const image = createNativeImageFromSources(args);
    if (!image || image.isEmpty()) return { ok: false, error: "image source unavailable" };
    clipboard.writeImage(image);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
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
  copyImageToClipboard,
  materializeImagePreviewURL,
  normalizeImageSourceToFilePath,
  readClipboardAsPNGAndSave,
};
