// @vitest-environment jsdom

import React, { act, useEffect, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import InteractiveImagePreview from "./interactive-image-preview";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const primaryData = "data:image/png;base64,UFJJTUFSWQ==";
const fallbackData = "data:image/png;base64,RkFMTEJBQ0s=";
const fallbackReference = "codexflow-history-image:fallback";
let mountedRoot: Root | undefined;
let mountedHost: HTMLDivElement | undefined;

type PreviewHarnessProps = { src?: string; fallbackSrc?: string; title?: string; failOldImageOnLayout?: boolean };

/** 用真实预览组件输出缩略图和回退状态，保留生产中的事件处理。 */
function PreviewHarness({ src, fallbackSrc, title = "图片", failOldImageOnLayout }: PreviewHarnessProps): React.ReactElement {
  const previousSrc = useRef(src);
  useLayoutEffect(() => {
    if (failOldImageOnLayout && previousSrc.current !== src)
      mountedHost?.querySelector<HTMLImageElement>('[data-testid="thumbnail"]')?.dispatchEvent(new Event("error"));
    previousSrc.current = src;
  }, [failOldImageOnLayout, src]);
  useEffect(() => {
    // 再覆盖子组件已排入预备更新、旧图尚未从页面移除的窗口。
    if (failOldImageOnLayout)
      mountedHost?.querySelector<HTMLImageElement>('[data-testid="thumbnail"]')?.dispatchEvent(new Event("error"));
  }, [failOldImageOnLayout, src]);
  return <InteractiveImagePreview src={src} fallbackSrc={fallbackSrc} alt="预览图片" dialogTitle={title}>
    {({ hasPreview, isUsingFallback, imageProps }) => (
      <div data-using-fallback={isUsingFallback}>
        {hasPreview ? <img {...imageProps} data-testid="thumbnail" /> : null}
      </div>
    )}
  </InteractiveImagePreview>;
}

/** 在同一测试窗口切换开发和打包地址，验证真实协议判断。 */
function setPreviewPageUrl(url: string): void {
  const environment = globalThis as unknown as { jsdom: { reconfigure: (options: { url: string }) => void } };
  environment.jsdom.reconfigure({ url });
}

/** 挂载或更新预览，等待宿主物化与 React 状态提交。 */
async function renderPreview(props: PreviewHarnessProps): Promise<void> {
  if (!mountedHost) {
    mountedHost = document.createElement("div");
    document.body.appendChild(mountedHost);
    mountedRoot = createRoot(mountedHost);
  }
  await act(async () => mountedRoot?.render(<PreviewHarness {...props} />));
}

/** 返回当前缩略图，缺失时给出清楚的测试诊断。 */
function getThumbnail(): HTMLImageElement {
  const image = mountedHost?.querySelector<HTMLImageElement>('[data-testid="thumbnail"]');
  if (!image) throw new Error("预览缩略图不存在");
  return image;
}

/** 触发浏览器加载失败事件，等待按需回退完成。 */
async function failThumbnail(): Promise<void> {
  await act(async () => getThumbnail().dispatchEvent(new Event("error")));
}

/** 注入最小宿主接口，并记录卸载后是否仍错误提交物化日志。 */
function installImageHost(materializePreviewURL: (args: { src?: string }) => Promise<{ ok: boolean; src?: string }>) {
  const perfLogCritical = vi.fn();
  Object.defineProperty(window, "host", {
    configurable: true,
    value: { images: { materializePreviewURL }, utils: { perfLogCritical } },
  });
  return { perfLogCritical };
}

afterEach(() => {
  act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  mountedHost = undefined;
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "host");
  setPreviewPageUrl("http://localhost/");
  vi.restoreAllMocks();
});

describe.each(["http://localhost/", "file:///preview/index.html"])("InteractiveImagePreview 页面 %s", (pageUrl) => {
  it("正常本地图不读取回退引用，主图失败后仅读取一次，标题刷新保留回退", async () => {
    setPreviewPageUrl(pageUrl);
    const materialize = vi.fn(async ({ src }: { src?: string }) => ({
      ok: true, src: src === fallbackReference ? fallbackData : primaryData,
    }));
    installImageHost(materialize);
    const props = { src: "file:///C:/workspace/image.png", fallbackSrc: fallbackReference };
    await renderPreview(props);
    expect(materialize.mock.calls.some(([args]) => args.src === fallbackReference)).toBe(false);
    expect(getThumbnail().getAttribute("src")).toBe(pageUrl.startsWith("http:") ? primaryData : props.src);
    await act(async () => {
      const image = getThumbnail();
      image.dispatchEvent(new Event("error"));
      image.dispatchEvent(new Event("error"));
    });
    expect(materialize.mock.calls.filter(([args]) => args.src === fallbackReference)).toHaveLength(1);
    expect(getThumbnail().getAttribute("src")).toBe(fallbackData);
    expect(mountedHost?.querySelector('[data-using-fallback="true"]')).not.toBeNull();
    const callsAfterFallback = materialize.mock.calls.length;
    await renderPreview({ ...props, title: "更新标题" });
    expect(getThumbnail().getAttribute("src")).toBe(fallbackData);
    expect(materialize).toHaveBeenCalledTimes(callsAfterFallback);
    await failThumbnail();
    expect(getThumbnail().dataset.cfPreviewBroken).toBe("1");
    expect(materialize).toHaveBeenCalledTimes(callsAfterFallback);
  });

  it("主图为历史引用时在开发和打包环境均按需物化", async () => {
    setPreviewPageUrl(pageUrl);
    const materialize = vi.fn().mockResolvedValue({ ok: true, src: primaryData });
    installImageHost(materialize);
    await renderPreview({ src: "codexflow-history-image:primary", fallbackSrc: fallbackReference });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize).toHaveBeenCalledWith({ src: "codexflow-history-image:primary" });
    expect(getThumbnail().getAttribute("src")).toBe(primaryData);
  });

  it("仅有回退引用时仍能显示图片", async () => {
    setPreviewPageUrl(pageUrl);
    const materialize = vi.fn().mockResolvedValue({ ok: true, src: fallbackData });
    installImageHost(materialize);
    await renderPreview({ fallbackSrc: fallbackReference });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(getThumbnail().getAttribute("src")).toBe(fallbackData);
  });

  it("普通 data 地址回退保持兼容且不调用宿主物化", async () => {
    setPreviewPageUrl(pageUrl);
    const materialize = vi.fn();
    installImageHost(materialize);
    await renderPreview({ src: primaryData, fallbackSrc: fallbackData });
    await failThumbnail();
    expect(getThumbnail().getAttribute("src")).toBe(fallbackData);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("读取回退期间切换图片不会请求新回退或污染新主图", async () => {
    setPreviewPageUrl(pageUrl);
    let finishFallback: ((result: { ok: boolean; src: string }) => void) | undefined;
    const materialize = vi.fn(() => new Promise<{ ok: boolean; src: string }>((resolve) => { finishFallback = resolve; }));
    installImageHost(materialize);
    await renderPreview({ src: primaryData, fallbackSrc: fallbackReference });
    await failThumbnail();
    const newPrimary = "data:image/png;base64,TkVX";
    await renderPreview({ src: newPrimary, fallbackSrc: "codexflow-history-image:new-fallback" });
    await act(async () => { finishFallback?.({ ok: true, src: fallbackData }); });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(getThumbnail().getAttribute("src")).toBe(newPrimary);
    expect(mountedHost?.querySelector('[data-using-fallback="false"]')).not.toBeNull();
  });

  it("换图提交时旧缩略图报错，不提前读取新图片回退", async () => {
    setPreviewPageUrl(pageUrl);
    let finishPrimary: ((result: { ok: boolean; src: string }) => void) | undefined;
    const materialize = vi.fn(({ src }: { src?: string }) => {
      if (src === "codexflow-history-image:new-primary")
        return new Promise<{ ok: boolean; src: string }>((resolve) => { finishPrimary = resolve; });
      return Promise.resolve({ ok: true, src: fallbackData });
    });
    installImageHost(materialize);
    await renderPreview({ src: primaryData, fallbackSrc: fallbackReference });
    await renderPreview({
      src: "codexflow-history-image:new-primary", fallbackSrc: "codexflow-history-image:new-fallback", failOldImageOnLayout: true,
    });
    expect(materialize.mock.calls.map(([args]) => args.src)).toEqual(["codexflow-history-image:new-primary"]);
    const newPrimary = "data:image/png;base64,TkVX";
    await act(async () => { finishPrimary?.({ ok: true, src: newPrimary }); });
    expect(getThumbnail().getAttribute("src")).toBe(newPrimary);
    expect(mountedHost?.querySelector('[data-using-fallback="false"]')).not.toBeNull();
  });

  it("卸载后丢弃迟到的回退结果和物化日志", async () => {
    setPreviewPageUrl(pageUrl);
    let finishFallback: ((result: { ok: boolean; src: string }) => void) | undefined;
    const materialize = vi.fn(() => new Promise<{ ok: boolean; src: string }>((resolve) => { finishFallback = resolve; }));
    const { perfLogCritical } = installImageHost(materialize);
    await renderPreview({ src: primaryData, fallbackSrc: fallbackReference });
    await failThumbnail();
    act(() => mountedRoot?.unmount());
    mountedRoot = undefined;
    const previousLogs = perfLogCritical.mock.calls.length;
    await act(async () => { finishFallback?.({ ok: true, src: fallbackData }); });
    expect(perfLogCritical).toHaveBeenCalledTimes(previousLogs);
    expect(mountedHost?.querySelector("img")).toBeNull();
  });
});

describe("InteractiveImagePreview 开发环境主图准备失败", () => {
  it.each(["empty", "reject"])("主图物化 %s 时无需 img 错误事件即可读取回退", async (failure) => {
    setPreviewPageUrl("http://localhost/");
    const materialize = vi.fn(async ({ src }: { src?: string }) => {
      if (src === fallbackReference) return { ok: true, src: fallbackData };
      if (failure === "reject") throw new Error("图片无法读取");
      return { ok: false };
    });
    installImageHost(materialize);
    await renderPreview({ src: "file:///C:/workspace/missing.png", fallbackSrc: fallbackReference });
    expect(materialize).toHaveBeenCalledTimes(2);
    expect(materialize).toHaveBeenLastCalledWith({ src: fallbackReference });
    expect(getThumbnail().getAttribute("src")).toBe(fallbackData);
  });
});
