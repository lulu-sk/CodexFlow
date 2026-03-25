import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { materializeImagePreviewURL, normalizeImageSourceToFilePath } from "./images";

const cleanupDirs = new Set<string>();

/**
 * 中文说明：创建临时图片文件，供本地预览物化测试复用。
 */
async function createTempImageFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexflow-image-preview-"));
  cleanupDirs.add(dir);
  const filePath = path.join(dir, "preview-test.png");
  await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return filePath;
}

afterEach(async () => {
  for (const dir of cleanupDirs) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {}
  }
  cleanupDirs.clear();
});

describe("electron/images", () => {
  it("会把 file URL 规范化为主进程可读取的本地路径", async () => {
    const filePath = await createTempImageFile();
    const fileUrl = pathToFileURL(filePath).toString();
    expect(normalizeImageSourceToFilePath(fileUrl)).toBe(filePath);
  });

  it("会把本地图片来源物化为 data URL", async () => {
    const filePath = await createTempImageFile();
    const result = await materializeImagePreviewURL(filePath);
    expect(result.ok).toBe(true);
    expect(String(result.ok ? result.src : "")).toMatch(/^data:image\/png;base64,/);
  });
});
