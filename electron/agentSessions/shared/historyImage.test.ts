import { afterEach, describe, expect, it, vi } from "vitest";
import fs, { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createHistoryImageContent, extractImagePathCandidatesFromText, historyImagePathExists, toHistoryImagePreviewUrl } from "./historyImage";

const tempDirs: string[] = [];

/**
 * 中文说明：创建临时图片文件，供路径归一化相关测试复用。
 */
async function createTempImageFile(fileName = "history-image.png"): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-history-image-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, fileName);
  await fsp.writeFile(filePath, "fake-image", "utf8");
  return filePath;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {}
  }));
});

describe("electron/agentSessions/shared/historyImage", () => {
  it.each([false, true])("有内嵌回退的本地图片延后磁盘检查，保留两种来源（内嵌优先：%s）", (preferDataUrl) => {
    const exists = vi.spyOn(fs, "existsSync").mockImplementation(() => { throw new Error("解析阶段不应检查图片文件"); });
    const localPath = "C:\\workspace\\fixtures\\image.png";
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const previewUrl = toHistoryImagePreviewUrl(localPath);
    const image = createHistoryImageContent({ localPath, dataUrl, deferLocalFileCheck: true, preferDataUrl });
    expect(exists).not.toHaveBeenCalled();
    expect(image?.src).toBe(preferDataUrl ? dataUrl : previewUrl);
    expect(image?.fallbackSrc).toBe(preferDataUrl ? previewUrl : dataUrl);
    expect(image?.localPath).toBe(localPath);
  });

  it("延后检查也兼容单独提供的 Base64 图片数据", () => {
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const image = createHistoryImageContent({ localPath: "C:\\workspace\\fixtures\\image.png", base64Data: "aGVsbG8=", deferLocalFileCheck: true });
    expect(exists).not.toHaveBeenCalled();
    expect(image?.src).toMatch(/^file:\/\//);
    expect(image?.fallbackSrc).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("默认仍检查本地文件，文件不存在时直接使用会话内图片", () => {
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const image = createHistoryImageContent({ localPath: "C:\\workspace\\fixtures\\image.png", dataUrl });
    expect(exists).toHaveBeenCalled();
    expect(image?.src).toBe(dataUrl);
    expect(image?.fallbackSrc).toBeUndefined();
  });

  it("没有会话内回退数据时仍检查文件，不创建失效的路径图片", () => {
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(createHistoryImageContent({ localPath: "C:\\workspace\\fixtures\\image.png", deferLocalFileCheck: true })).toBeNull();
    expect(exists).toHaveBeenCalled();
  });

  it("无法生成本地预览地址时仍检查路径并保留会话内图片", () => {
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const image = createHistoryImageContent({ localPath: "relative-image.png", dataUrl, deferLocalFileCheck: true });
    expect(exists).toHaveBeenCalled();
    expect(image?.src).toBe(dataUrl);
    expect(image?.fallbackSrc).toBeUndefined();
  });

  it("嵌套工具文本抽取的转义路径会生成一致的图片元信息", () => {
    const localPath = "C:\\workspace\\fixtures\\image.png";
    const candidates = extractImagePathCandidatesFromText(JSON.stringify({ output: JSON.stringify({ path: localPath }) }));
    expect(candidates).toEqual([localPath]);
    const image = createHistoryImageContent({ localPath: candidates[0], dataUrl: "data:image/png;base64,AAAA" });
    expect(image?.localPath).toBe(localPath);
    expect(image?.text).toContain(`路径: ${localPath}`);
    expect(toHistoryImagePreviewUrl(candidates[0])).toBe("file:///C:/workspace/fixtures/image.png");
    expect(extractImagePathCandidatesFromText(JSON.stringify({ path: "\\\\server\\share\\image.png" })))
      .toEqual(["\\\\server\\share\\image.png"]);
  });

  it("会完整提取使用正斜杠的 Windows 图片绝对路径", () => {
    const text = "请查看 C:/demo/assets/example-image.png 并继续分析";
    expect(extractImagePathCandidatesFromText(text)).toEqual(["C:/demo/assets/example-image.png"]);
  });

  it.each([1, 2, 4, 8])("多路径工具参数每段 %i 个反斜杠时，不把前面的非图片路径拼进图片路径", (count) => {
    const separator = "\\".repeat(count);
    const text = `Get-Item -LiteralPath 'C:${separator}workspace${separator}fixtures${separator}notes.txt','C:${separator}workspace${separator}fixtures${separator}image-a.png','C:${separator}workspace${separator}fixtures${separator}image-b.png'`;
    expect(extractImagePathCandidatesFromText(text)).toEqual([
      "C:\\workspace\\fixtures\\image-a.png",
      "C:\\workspace\\fixtures\\image-b.png",
    ]);
  });

  it.each(["prefix\\\\server\\share\\image.png", "C:\\\\server\\share\\image.png", "\\\\server:invalid\\share\\image.png", "\\\\server\\share:invalid\\image.png"])(
    "不会从路径正文内部或非法 UNC 名称提取网络路径：%s", (text) => {
      const candidates = extractImagePathCandidatesFromText(text);
      if (text.startsWith("C:"))
        expect(candidates).toEqual(["C:\\server\\share\\image.png"]);
      else
        expect(candidates).toEqual([]);
    },
  );

  (process.platform === "win32" ? it : it.skip)("会把 /mnt 形式的 Windows 图片路径识别为本地文件并生成 Windows 预览地址", async () => {
    const localImagePath = await createTempImageFile("mnt-history-image.png");
    const posixWinPath = localImagePath.replace(/\\/g, "/");
    const driveMatch = posixWinPath.match(/^([A-Za-z]):\/(.*)$/);
    expect(driveMatch?.[1]).toBeTruthy();
    const drive = String(driveMatch?.[1] || "").toLowerCase();
    const rest = String(driveMatch?.[2] || "");
    const mntPath = `/mnt/${drive}/${rest}`;

    expect(historyImagePathExists(mntPath)).toBe(true);
    expect(toHistoryImagePreviewUrl(mntPath)).toBe(`file:///${posixWinPath}`);
    expect(createHistoryImageContent({ localPath: mntPath })?.localPath).toBe(mntPath);
  });
});
