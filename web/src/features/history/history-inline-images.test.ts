import { describe, expect, it } from "vitest";

import {
  mergeHistoryInlineImageWithPathFallback,
  resolveHistoryInlineImageRenderState,
  toHistoryInlineImageFallbackSrc,
  toHistoryInlineImagePreviewSrc,
} from "./history-inline-images";

describe("web/features/history/history-inline-images", () => {
  it.each([1, 2, 4, 8])("多路径工具文本每段 %i 个反斜杠时，前端仍正确识别两张图片", (count) => {
    const separator = "\\".repeat(count);
    const text = `Get-Item -LiteralPath 'C:${separator}workspace${separator}fixtures${separator}notes.txt','C:${separator}workspace${separator}fixtures${separator}image-a.png','C:${separator}workspace${separator}fixtures${separator}image-b.png'`;
    const paths = ["C:\\workspace\\fixtures\\image-a.png", "C:\\workspace\\fixtures\\image-b.png"];
    const state = resolveHistoryInlineImageRenderState([{
      messageKey: "message",
      message: {
        role: "assistant", content: [
          { type: "text", text },
          ...paths.map((localPath) => ({ type: "image", text: "图片", localPath, src: "data:image/png;base64,AAAA" })),
        ],
      },
    }]);
    expect(state.matchesByTextItemKey.get("message:content:0")?.map((match) => match.path)).toEqual(paths);
  });

  it("工具转义路径与旧缓存图片均规整，保留网络路径前缀", () => {
    const rawPath = "C:\\\\workspace\\\\image.png";
    expect(toHistoryInlineImagePreviewSrc(rawPath)).toBe("file:///C:/workspace/image.png");
    expect(toHistoryInlineImageFallbackSrc(rawPath)).toBe("file:///mnt/c/workspace/image.png");
    expect(toHistoryInlineImagePreviewSrc("\\\\\\\\server\\\\share\\\\image.png"))
      .toBe("file://server/share/image.png");
    const image = mergeHistoryInlineImageWithPathFallback({
      type: "image", localPath: rawPath, text: `图片\n路径: ${rawPath}`, src: "file:///C://workspace//image.png",
    }, rawPath);
    expect(image.localPath).toBe("C:\\workspace\\image.png");
    expect(image.text).toBe("图片\n路径: C:\\workspace\\image.png");
    expect(image.src).toBe("file:///C:/workspace/image.png");
  });

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
