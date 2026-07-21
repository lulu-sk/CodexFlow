import { describe, expect, it } from "vitest";

import {
  mergeHistoryInlineImageWithPathFallback,
  toHistoryInlineImageFallbackSrc,
  toHistoryInlineImagePreviewSrc,
} from "./history-inline-images";

describe("web/features/history/history-inline-images", () => {
  it("Windows 盘符路径会稳定映射为本地 file:///C:/ 预览地址", () => {
    const input = "C:\\Users\\demo\\image-example.png";
    expect(toHistoryInlineImagePreviewSrc(input)).toBe("file:///C:/Users/demo/image-example.png");
    expect(toHistoryInlineImageFallbackSrc(input)).toBe("file:///mnt/c/Users/demo/image-example.png");
  });

  it("/mnt 形式路径会保留原始预览并提供 Windows 盘符回退", () => {
    const input = "/mnt/c/Users/demo/image-example.png";
    expect(toHistoryInlineImagePreviewSrc(input)).toBe("file:///mnt/c/Users/demo/image-example.png");
    expect(toHistoryInlineImageFallbackSrc(input)).toBe("file:///C:/Users/demo/image-example.png");
  });

  it("本地图片失效时会优先回退到会话内图片数据", () => {
    const localPath = "C:\\workspace\\fixtures\\missing-image.png";
    const dataUrl = "data:image/png;base64,QUFB";
    const merged = mergeHistoryInlineImageWithPathFallback({
      type: "image",
      text: `图片\n路径: ${localPath}`,
      src: "file:///C:/workspace/fixtures/missing-image.png",
      fallbackSrc: dataUrl,
      localPath,
      mimeType: "image/png",
    }, localPath);

    expect(merged.src).toBe("file:///C:/workspace/fixtures/missing-image.png");
    expect(merged.fallbackSrc).toBe(dataUrl);
  });
});
