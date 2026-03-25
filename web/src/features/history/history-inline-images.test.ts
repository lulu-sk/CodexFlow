import { describe, expect, it } from "vitest";

import { toHistoryInlineImageFallbackSrc, toHistoryInlineImagePreviewSrc } from "./history-inline-images";

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
});
