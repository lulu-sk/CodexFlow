// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type InteractiveImagePreviewNaturalSize = {
  width: number;
  height: number;
};

type InteractiveImagePreviewPanOffset = {
  x: number;
  y: number;
};

type InteractiveImagePreviewDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
};

const INTERACTIVE_IMAGE_PREVIEW_MIN_ZOOM = 1;
const INTERACTIVE_IMAGE_PREVIEW_MAX_ZOOM = 6;
const INTERACTIVE_IMAGE_PREVIEW_WHEEL_ZOOM_SPEED = 0.0016;
const INTERACTIVE_IMAGE_PREVIEW_LOCAL_SOURCE_PATTERN = /^(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/mnt\/[A-Za-z]\/|\/(?:home|root|Users)\/)/i;

/**
 * 中文说明：将缩放或位移数值限制在指定区间内，避免拖拽/滚轮缩放越界。
 */
function clampInteractiveImagePreviewValue(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (min > max) return value;
  return Math.min(Math.max(value, min), max);
}

/**
 * 中文说明：压缩图片预览诊断日志中的长字符串，避免 `data:` URL 把日志文件刷爆。
 */
function summarizeInteractiveImagePreviewLogValue(value: unknown): unknown {
  const raw = String(value ?? "");
  if (!raw) return raw;
  if (/^data:image\//i.test(raw)) {
    const mime = raw.match(/^data:([^;,]+)/i)?.[1] || "image/unknown";
    return `${mime};len=${raw.length}`;
  }
  if (raw.length > 240) return `${raw.slice(0, 240)}...(len=${raw.length})`;
  return value;
}

/**
 * 中文说明：判断当前渲染环境是否需要把本地图片来源物化为 `data:` URL。
 * - 开发态 `http://127.0.0.1:5173` 无法直接加载 `file:///`；
 * - 打包态 `file://` 仍保留原始本地地址，避免不必要的内存放大。
 */
function shouldMaterializeInteractiveImagePreviewSource(value?: string): boolean {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (!INTERACTIVE_IMAGE_PREVIEW_LOCAL_SOURCE_PATTERN.test(raw)) return false;
  if (typeof window === "undefined") return false;
  const protocol = String(window.location.protocol || "").toLowerCase();
  return protocol === "http:" || protocol === "https:";
}

/**
 * 中文说明：请求主进程把本地图片来源转换为当前渲染进程可安全加载的预览地址。
 */
async function materializeInteractiveImagePreviewSource(value?: string): Promise<string> {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!shouldMaterializeInteractiveImagePreviewSource(raw)) return raw;
  try {
    const materialize = window.host?.images?.materializePreviewURL;
    if (typeof materialize !== "function")
      return "";

    const res = await materialize({ src: raw });
    if (res?.ok && typeof res.src === "string" && res.src.trim())
      return res.src.trim();
  } catch {}
  return "";
}

type InteractiveImagePreviewRenderArgs = {
  hasPreview: boolean;
  resolvedSrc: string;
  isUsingFallback: boolean;
  hoverTriggerProps: {
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => void;
    onMouseLeave: () => void;
  };
  openDialog: () => void;
  imageProps: React.ImgHTMLAttributes<HTMLImageElement>;
};

type InteractiveImagePreviewProps = {
  src?: string;
  fallbackSrc?: string;
  alt: string;
  dialogTitle: string;
  dialogDescription?: string;
  dialogMeta?: React.ReactNode;
  hoverImageClassName?: string;
  dialogImageClassName?: string;
  children: (args: InteractiveImagePreviewRenderArgs) => React.ReactNode;
};

/**
 * 中文说明：为任意图片缩略图提供统一的悬停预览与点击弹窗能力。
 * - 悬停：展示和 chips 一致的浮层预览；
 * - 点击：打开适合查看大图的 Dialog；
 * - 失效：优先尝试回退到后端提供的 `fallbackSrc`。
 */
export default function InteractiveImagePreview({
  src,
  fallbackSrc,
  alt,
  dialogTitle,
  dialogDescription,
  dialogMeta,
  hoverImageClassName,
  dialogImageClassName,
  children,
}: InteractiveImagePreviewProps) {
  const primarySrc = String(src || "").trim();
  const stableFallbackSrc = String(fallbackSrc || "").trim();
  const [preparedPrimarySrc, setPreparedPrimarySrc] = useState<string>(() => (
    shouldMaterializeInteractiveImagePreviewSource(primarySrc) ? "" : primarySrc
  ));
  const [preparedFallbackSrc, setPreparedFallbackSrc] = useState<string>(() => (
    shouldMaterializeInteractiveImagePreviewSource(stableFallbackSrc) ? "" : stableFallbackSrc
  ));
  const [resolvedSrc, setResolvedSrc] = useState<string>(() => {
    const nextPrimarySrc = shouldMaterializeInteractiveImagePreviewSource(primarySrc) ? "" : primarySrc;
    const nextFallbackSrc = shouldMaterializeInteractiveImagePreviewSource(stableFallbackSrc) ? "" : stableFallbackSrc;
    return nextPrimarySrc || nextFallbackSrc;
  });
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [naturalSize, setNaturalSize] = useState<InteractiveImagePreviewNaturalSize | null>(null);
  const [dialogZoom, setDialogZoom] = useState<number>(INTERACTIVE_IMAGE_PREVIEW_MIN_ZOOM);
  const [dialogPan, setDialogPan] = useState<InteractiveImagePreviewPanOffset>({ x: 0, y: 0 });
  const [dialogDragging, setDialogDragging] = useState(false);
  const hoverAnchorRef = useRef<HTMLElement | null>(null);
  const dialogViewportRef = useRef<HTMLDivElement | null>(null);
  const dialogImageRef = useRef<HTMLImageElement | null>(null);
  const dialogZoomRef = useRef<number>(INTERACTIVE_IMAGE_PREVIEW_MIN_ZOOM);
  const dialogPanRef = useRef<InteractiveImagePreviewPanOffset>({ x: 0, y: 0 });
  const dialogDragStateRef = useRef<InteractiveImagePreviewDragState | null>(null);
  const previewInitLogKeyRef = useRef<string>("");
  const previewLoadLogKeysRef = useRef<Set<string>>(new Set());

  /**
   * 中文说明：写入图片预览链路关键日志，帮助定位真实 `src/currentSrc` 与回退切换过程。
   */
  const logInteractiveImagePreview = useCallback((event: string, payload: Record<string, unknown>) => {
    try {
      const logger = (window as any)?.host?.utils?.perfLogCritical;
      if (typeof logger !== "function")
        return;

      const parts = Object.entries(payload).map(([key, value]) => `${key}=${JSON.stringify(summarizeInteractiveImagePreviewLogValue(value))}`);
      void logger(`[interactive-image-preview] ${event} ${parts.join(" ")}`);
    } catch {}
  }, []);

  useEffect(() => {
    let active = true;
    previewLoadLogKeysRef.current.clear();

    const nextDirectPrimarySrc = shouldMaterializeInteractiveImagePreviewSource(primarySrc) ? "" : primarySrc;
    const nextDirectFallbackSrc = shouldMaterializeInteractiveImagePreviewSource(stableFallbackSrc) ? "" : stableFallbackSrc;
    setPreparedPrimarySrc(nextDirectPrimarySrc);
    setPreparedFallbackSrc(nextDirectFallbackSrc);

    (async () => {
      const nextPrimarySrc = shouldMaterializeInteractiveImagePreviewSource(primarySrc)
        ? await materializeInteractiveImagePreviewSource(primarySrc)
        : nextDirectPrimarySrc;
      if (!active) return;
      setPreparedPrimarySrc(nextPrimarySrc);
      if (nextPrimarySrc && nextPrimarySrc !== primarySrc)
        logInteractiveImagePreview("materialized", { title: dialogTitle, alt, from: primarySrc, toKind: nextPrimarySrc, slot: "primary" });

      const nextFallbackSrc = shouldMaterializeInteractiveImagePreviewSource(stableFallbackSrc)
        ? await materializeInteractiveImagePreviewSource(stableFallbackSrc)
        : nextDirectFallbackSrc;
      if (!active) return;
      setPreparedFallbackSrc(nextFallbackSrc);
      if (nextFallbackSrc && nextFallbackSrc !== stableFallbackSrc)
        logInteractiveImagePreview("materialized", { title: dialogTitle, alt, from: stableFallbackSrc, toKind: nextFallbackSrc, slot: "fallback" });
    })();

    return () => {
      active = false;
    };
  }, [alt, dialogTitle, logInteractiveImagePreview, primarySrc, stableFallbackSrc]);

  useEffect(() => {
    setResolvedSrc(preparedPrimarySrc || preparedFallbackSrc);
  }, [preparedFallbackSrc, preparedPrimarySrc]);

  useEffect(() => {
    const candidate = primarySrc || stableFallbackSrc;
    if (!/^file:\/\//i.test(candidate))
      return;

    const logKey = `${primarySrc}@@${stableFallbackSrc}@@${dialogTitle}@@${alt}`;
    if (previewInitLogKeyRef.current === logKey)
      return;

    previewInitLogKeyRef.current = logKey;
    logInteractiveImagePreview("init", {
      title: dialogTitle,
      alt,
      primarySrc,
      fallbackSrc: stableFallbackSrc,
      resolvedSrc: candidate,
    });
  }, [alt, dialogTitle, logInteractiveImagePreview, primarySrc, stableFallbackSrc]);

  useEffect(() => {
    setNaturalSize(null);
  }, [resolvedSrc]);

  useEffect(() => {
    dialogZoomRef.current = dialogZoom;
  }, [dialogZoom]);

  useEffect(() => {
    dialogPanRef.current = dialogPan;
  }, [dialogPan]);

  /**
   * 中文说明：当主图失效时自动切到回退图；若已无可用回退，则标记为损坏。
   */
  const handleImageError = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    const currentSrc = String(event.currentTarget.currentSrc || event.currentTarget.src || "");
    logInteractiveImagePreview("error", {
      title: dialogTitle,
      alt,
      primarySrc,
      fallbackSrc: stableFallbackSrc,
      resolvedSrc,
      currentSrc,
      naturalWidth: Number(event.currentTarget.naturalWidth || 0),
      naturalHeight: Number(event.currentTarget.naturalHeight || 0),
      action: stableFallbackSrc && resolvedSrc !== stableFallbackSrc ? "switch-fallback" : "mark-broken",
    });
    if (preparedFallbackSrc && resolvedSrc !== preparedFallbackSrc) {
      setResolvedSrc(preparedFallbackSrc);
      return;
    }
    try {
      event.currentTarget.dataset.cfPreviewBroken = "1";
    } catch {}
  }, [alt, dialogTitle, logInteractiveImagePreview, preparedFallbackSrc, primarySrc, resolvedSrc, stableFallbackSrc]);

  /**
   * 中文说明：记录触发元素位置，用于在视口中计算悬停预览浮层位置。
   */
  const handleMouseEnter = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!resolvedSrc) return;
    hoverAnchorRef.current = event.currentTarget;
    setHoverRect(event.currentTarget.getBoundingClientRect());
  }, [resolvedSrc]);

  /**
   * 中文说明：关闭悬停预览浮层。
   */
  const handleMouseLeave = useCallback(() => {
    hoverAnchorRef.current = null;
    setHoverRect(null);
  }, []);

  /**
   * 中文说明：打开大图查看弹窗。
   */
  const openDialog = useCallback(() => {
    if (!resolvedSrc) return;
    hoverAnchorRef.current = null;
    setHoverRect(null);
    setDialogOpen(true);
  }, [resolvedSrc]);

  /**
   * 中文说明：重置大图弹窗的缩放与位移状态，确保每次打开都从“适配视口”的初始状态开始。
   */
  const resetDialogTransform = useCallback(() => {
    dialogDragStateRef.current = null;
    dialogZoomRef.current = INTERACTIVE_IMAGE_PREVIEW_MIN_ZOOM;
    dialogPanRef.current = { x: 0, y: 0 };
    setDialogDragging(false);
    setDialogZoom(INTERACTIVE_IMAGE_PREVIEW_MIN_ZOOM);
    setDialogPan({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    if (!dialogOpen) {
      resetDialogTransform();
      return;
    }
    resetDialogTransform();
  }, [dialogOpen, resolvedSrc, resetDialogTransform]);

  /**
   * 中文说明：记录图片原始分辨率，供大图弹窗优先按自身尺寸展示。
   */
  const handleImageLoad = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    const nextWidth = Number(event.currentTarget.naturalWidth || 0);
    const nextHeight = Number(event.currentTarget.naturalHeight || 0);
    if (nextWidth <= 0 || nextHeight <= 0) return;

    const currentSrc = String(event.currentTarget.currentSrc || event.currentTarget.src || "");
    const logKey = `${currentSrc}@@${nextWidth}x${nextHeight}`;
    if (currentSrc && !previewLoadLogKeysRef.current.has(logKey)) {
      previewLoadLogKeysRef.current.add(logKey);
      logInteractiveImagePreview("load", {
        title: dialogTitle,
        alt,
        primarySrc,
        fallbackSrc: stableFallbackSrc,
        resolvedSrc,
        currentSrc,
        naturalWidth: nextWidth,
        naturalHeight: nextHeight,
      });
    }

    setNaturalSize((previous) => {
      if (previous?.width === nextWidth && previous.height === nextHeight) return previous;
      return { width: nextWidth, height: nextHeight };
    });
  }, [alt, dialogTitle, logInteractiveImagePreview, primarySrc, resolvedSrc, stableFallbackSrc]);

  /**
   * 中文说明：在滚动或窗口尺寸变化后刷新浮层锚点位置，避免共享预览组件引入交互回退。
   */
  useEffect(() => {
    if (!hoverRect) return;

    const refreshHoverRect = () => {
      const anchor = hoverAnchorRef.current;
      if (!anchor || !anchor.isConnected) {
        hoverAnchorRef.current = null;
        setHoverRect(null);
        return;
      }
      setHoverRect((previous) => {
        const nextRect = anchor.getBoundingClientRect();
        if (
          previous &&
          previous.left === nextRect.left &&
          previous.top === nextRect.top &&
          previous.width === nextRect.width &&
          previous.height === nextRect.height
        ) {
          return previous;
        }
        return nextRect;
      });
    };

    refreshHoverRect();
    window.addEventListener("scroll", refreshHoverRect, true);
    window.addEventListener("resize", refreshHoverRect);
    return () => {
      window.removeEventListener("scroll", refreshHoverRect, true);
      window.removeEventListener("resize", refreshHoverRect);
    };
  }, [hoverRect]);

  /**
   * 中文说明：按当前视口和基础图片尺寸约束拖拽位移，避免大图被拖出可视范围太远。
   */
  const clampDialogPanOffset = useCallback((nextPan: InteractiveImagePreviewPanOffset, zoomValue: number): InteractiveImagePreviewPanOffset => {
    if (zoomValue <= INTERACTIVE_IMAGE_PREVIEW_MIN_ZOOM + 0.001) return { x: 0, y: 0 };

    const viewport = dialogViewportRef.current;
    const image = dialogImageRef.current;
    if (!viewport || !image) return nextPan;

    const viewportWidth = Math.max(0, viewport.clientWidth);
    const viewportHeight = Math.max(0, viewport.clientHeight);
    const imageWidth = Math.max(0, image.clientWidth);
    const imageHeight = Math.max(0, image.clientHeight);
    const maxX = Math.max(0, ((imageWidth * zoomValue) - viewportWidth) / 2);
    const maxY = Math.max(0, ((imageHeight * zoomValue) - viewportHeight) / 2);

    return {
      x: clampInteractiveImagePreviewValue(nextPan.x, -maxX, maxX),
      y: clampInteractiveImagePreviewValue(nextPan.y, -maxY, maxY),
    };
  }, []);

  /**
   * 中文说明：统一提交大图查看器的缩放与位移状态，确保 state 与 ref 始终一致。
   */
  const commitDialogTransform = useCallback((
    nextZoom: number,
    nextPan: InteractiveImagePreviewPanOffset,
  ) => {
    const clampedZoom = clampInteractiveImagePreviewValue(
      nextZoom,
      INTERACTIVE_IMAGE_PREVIEW_MIN_ZOOM,
      INTERACTIVE_IMAGE_PREVIEW_MAX_ZOOM,
    );
    const clampedPan = clampDialogPanOffset(nextPan, clampedZoom);
    dialogZoomRef.current = clampedZoom;
    dialogPanRef.current = clampedPan;
    setDialogZoom(clampedZoom);
    setDialogPan(clampedPan);
  }, [clampDialogPanOffset]);

  /**
   * 中文说明：结束当前拖拽手势，恢复查看器的非拖拽状态。
   */
  const stopDialogDragging = useCallback(() => {
    dialogDragStateRef.current = null;
    setDialogDragging(false);
  }, []);

  /**
   * 中文说明：处理滚轮缩放，优先保持鼠标所在区域尽量稳定，提升查看大图时的定位感。
   */
  const handleDialogWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!dialogOpen || !resolvedSrc) return;
    event.preventDefault();

    const viewport = dialogViewportRef.current;
    const currentZoom = dialogZoomRef.current;
    const delta = -event.deltaY * INTERACTIVE_IMAGE_PREVIEW_WHEEL_ZOOM_SPEED;
    const nextZoom = clampInteractiveImagePreviewValue(
      currentZoom * (1 + delta),
      INTERACTIVE_IMAGE_PREVIEW_MIN_ZOOM,
      INTERACTIVE_IMAGE_PREVIEW_MAX_ZOOM,
    );
    if (Math.abs(nextZoom - currentZoom) < 0.001) return;

    if (!viewport) {
      commitDialogTransform(nextZoom, dialogPanRef.current);
      return;
    }

    const rect = viewport.getBoundingClientRect();
    const cursorX = event.clientX - rect.left - (rect.width / 2);
    const cursorY = event.clientY - rect.top - (rect.height / 2);
    const currentPan = dialogPanRef.current;
    const nextPan = nextZoom <= INTERACTIVE_IMAGE_PREVIEW_MIN_ZOOM + 0.001
      ? { x: 0, y: 0 }
      : {
          x: cursorX - (((cursorX - currentPan.x) / currentZoom) * nextZoom),
          y: cursorY - (((cursorY - currentPan.y) / currentZoom) * nextZoom),
        };

    commitDialogTransform(nextZoom, nextPan);
  }, [commitDialogTransform, dialogOpen, resolvedSrc]);

  /**
   * 中文说明：在放大状态下开始拖拽平移图片。
   */
  const handleDialogPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (dialogZoomRef.current <= INTERACTIVE_IMAGE_PREVIEW_MIN_ZOOM + 0.001) return;

    dialogDragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: dialogPanRef.current.x,
      originY: dialogPanRef.current.y,
    };
    setDialogDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
  }, []);

  /**
   * 中文说明：根据拖拽位移实时平移放大后的图片。
   */
  const handleDialogPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dialogDragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    const nextPan = clampDialogPanOffset({
      x: dragState.originX + (event.clientX - dragState.startX),
      y: dragState.originY + (event.clientY - dragState.startY),
    }, dialogZoomRef.current);
    dialogPanRef.current = nextPan;
    setDialogPan(nextPan);
  }, [clampDialogPanOffset]);

  /**
   * 中文说明：在拖拽结束或指针捕获丢失后清理拖拽状态。
   */
  const handleDialogPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dialogDragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {}
    stopDialogDragging();
  }, [stopDialogDragging]);

  /**
   * 中文说明：响应指针取消或捕获丢失，避免查看器卡在“拖拽中”状态。
   */
  const handleDialogPointerCancel = useCallback(() => {
    stopDialogDragging();
  }, [stopDialogDragging]);

  useEffect(() => {
    if (!dialogOpen) return;
    if (dialogZoomRef.current <= INTERACTIVE_IMAGE_PREVIEW_MIN_ZOOM + 0.001) return;
    const clampedPan = clampDialogPanOffset(dialogPanRef.current, dialogZoomRef.current);
    if (clampedPan.x === dialogPanRef.current.x && clampedPan.y === dialogPanRef.current.y) return;
    dialogPanRef.current = clampedPan;
    setDialogPan(clampedPan);
  }, [clampDialogPanOffset, dialogOpen, dialogZoom, naturalSize]);

  useEffect(() => {
    if (!dialogOpen) return;
    const handleResize = () => {
      const clampedPan = clampDialogPanOffset(dialogPanRef.current, dialogZoomRef.current);
      if (clampedPan.x === dialogPanRef.current.x && clampedPan.y === dialogPanRef.current.y) return;
      dialogPanRef.current = clampedPan;
      setDialogPan(clampedPan);
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [clampDialogPanOffset, dialogOpen]);

  const hasPreview = !!resolvedSrc;
  const isUsingFallback = !!preparedFallbackSrc && resolvedSrc === preparedFallbackSrc && resolvedSrc !== preparedPrimarySrc;
  const hoverTriggerProps = {
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
  };
  const compactMetaBadges = [
    naturalSize ? `${naturalSize.width} × ${naturalSize.height}` : "",
    dialogDescription ? dialogDescription : "",
    isUsingFallback ? "会话内图片数据" : "",
  ].filter((item) => String(item || "").trim().length > 0);
  const imageProps: React.ImgHTMLAttributes<HTMLImageElement> = {
    src: resolvedSrc,
    alt,
    loading: "lazy",
    decoding: "async",
    onLoad: handleImageLoad,
    onError: handleImageError,
  };

  return (
    <>
      {children({
        hasPreview,
        resolvedSrc,
        isUsingFallback,
        hoverTriggerProps,
        openDialog,
        imageProps,
      })}
      {hoverRect && resolvedSrc && typeof document !== "undefined"
        ? createPortal(
            (() => {
              const centerX = hoverRect.left + hoverRect.width / 2;
              const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 0;
              const anchorCenterY = hoverRect.top + hoverRect.height / 2;
              const preferBelow = !viewportHeight || anchorCenterY < viewportHeight * 0.5;
              const baseTop = preferBelow ? hoverRect.bottom + 8 : hoverRect.top - 8;
              const clampedTop = viewportHeight
                ? Math.min(Math.max(baseTop, 24), viewportHeight - 24)
                : baseTop;
              return (
                <div className="fixed z-[1200] pointer-events-none" style={{ left: centerX, top: clampedTop }}>
                  <div className={cn(
                    "rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple p-2 shadow-apple-lg transition-opacity dark:shadow-apple-dark-lg",
                    "-translate-x-1/2",
                    preferBelow ? "translate-y-0" : "-translate-y-full",
                  )}>
                    <img
                      src={resolvedSrc}
                      className={cn("block max-h-[28rem] max-w-[28rem] object-contain rounded-apple", hoverImageClassName)}
                      alt={alt}
                      loading="lazy"
                      decoding="async"
                      onError={handleImageError}
                    />
                  </div>
                </div>
              );
            })(),
            document.body,
          )
        : null}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="w-auto max-w-[calc(100vw-1rem)] overflow-visible rounded-none border-none bg-transparent p-0 shadow-none">
          <DialogHeader className="sr-only">
            <DialogTitle>{dialogTitle}</DialogTitle>
            {dialogDescription ? <DialogDescription>{dialogDescription}</DialogDescription> : null}
          </DialogHeader>
          <div className="flex max-h-[calc(100vh-1rem)] max-w-[calc(100vw-1rem)] flex-col items-center gap-2">
            <div
              ref={dialogViewportRef}
              className={cn(
                "relative flex items-center justify-center overflow-hidden rounded-[30px] border border-black/10 bg-[var(--cf-surface)]/75 p-[1px] shadow-[0_24px_80px_rgba(15,23,42,0.24)] backdrop-blur-apple-lg dark:border-white/10",
                dialogZoom > INTERACTIVE_IMAGE_PREVIEW_MIN_ZOOM + 0.001
                  ? (dialogDragging ? "cursor-grabbing" : "cursor-grab")
                  : "cursor-zoom-in",
              )}
              onWheel={handleDialogWheel}
              onPointerDown={handleDialogPointerDown}
              onPointerMove={handleDialogPointerMove}
              onPointerUp={handleDialogPointerUp}
              onPointerCancel={handleDialogPointerCancel}
              onLostPointerCapture={handleDialogPointerCancel}
            >
              <div className="flex max-h-[calc(100vh-8rem)] max-w-[calc(100vw-1rem)] items-center justify-center overflow-hidden rounded-[28px] bg-[var(--cf-surface-muted)]">
                <div
                  className="flex items-center justify-center will-change-transform"
                  style={{ transform: `translate3d(${dialogPan.x}px, ${dialogPan.y}px, 0)` }}
                >
                  {resolvedSrc ? (
                    <img
                      ref={dialogImageRef}
                      src={resolvedSrc}
                      className={cn(
                        "block h-auto w-auto max-h-[calc(100vh-8rem)] max-w-[calc(100vw-1rem)] select-none object-contain will-change-transform",
                        dialogImageClassName,
                      )}
                      style={{ transform: `scale(${dialogZoom})` }}
                      alt={alt}
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                      onLoad={handleImageLoad}
                      onError={handleImageError}
                    />
                  ) : null}
                </div>
              </div>
            </div>
            {(dialogTitle || compactMetaBadges.length > 0 || dialogMeta) ? (
              <div className="flex w-full justify-center px-3">
                <div className="max-w-[min(92vw,44rem)] rounded-apple-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2 shadow-apple-lg backdrop-blur-apple-lg dark:shadow-apple-dark-lg">
                  <div className="flex flex-wrap items-center justify-center gap-2 text-[11px] leading-4">
                    {dialogTitle ? (
                      <div className="max-w-[min(70vw,22rem)] truncate text-xs font-apple-medium text-[var(--cf-text-primary)]" title={dialogTitle}>
                        {dialogTitle}
                      </div>
                    ) : null}
                    {compactMetaBadges.map((item) => (
                      <span
                        key={`interactive-image-preview-meta-${item}`}
                        className="rounded-full bg-[var(--cf-surface-muted)] px-2 py-0.5 text-[10px] text-[var(--cf-text-secondary)]"
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                  {dialogMeta ? (
                    <div className="mt-1 max-h-16 overflow-auto rounded-apple bg-[var(--cf-surface-muted)] px-2 py-1 text-[10px] leading-4 text-[var(--cf-text-secondary)]">
                      {dialogMeta}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
