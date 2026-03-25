import { afterEach, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
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
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {}
  }));
});

describe("electron/agentSessions/shared/historyImage", () => {
  it("会完整提取使用正斜杠的 Windows 图片绝对路径", () => {
    const text = "请查看 C:/demo/assets/example-image.png 并继续分析";
    expect(extractImagePathCandidatesFromText(text)).toEqual(["C:/demo/assets/example-image.png"]);
  });

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
