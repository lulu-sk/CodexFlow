// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { Session } from "electron";

type ResponseHeaders = Record<string, string | string[]>;

const installedSessions = new WeakSet<Session>();

/**
 * 中文说明：以“不区分大小写”的方式查找响应头键名。
 */
function findHeaderKeyCaseInsensitive(headers: ResponseHeaders, targetName: string): string | null {
  const target = String(targetName || "").trim().toLowerCase();
  if (!target) return null;
  for (const k of Object.keys(headers || {})) {
    if (String(k).toLowerCase() === target) return k;
  }
  return null;
}

/**
 * 中文说明：克隆响应头对象，避免直接修改 Electron 传入的引用导致边界行为不确定。
 */
function cloneResponseHeaders(headers: ResponseHeaders | undefined): ResponseHeaders {
  const src = headers || {};
  const out: ResponseHeaders = {};
  for (const [k, v] of Object.entries(src)) {
    if (Array.isArray(v)) out[k] = [...v];
    else if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * 中文说明：向响应头追加一个值（若原本不存在则新建）。
 */
function appendHeaderValue(headers: ResponseHeaders, name: string, value: string): void {
  const key = findHeaderKeyCaseInsensitive(headers, name) || name;
  const curRaw = headers[key];
  const cur = Array.isArray(curRaw) ? curRaw : (typeof curRaw === "string" ? [curRaw] : []);
  headers[key] = [...cur, value];
}

/**
 * 中文说明：仅当响应头不存在时设置指定值（避免覆盖上游服务器/框架已设置的安全策略）。
 */
function setHeaderIfAbsent(headers: ResponseHeaders, name: string, value: string): void {
  const key = findHeaderKeyCaseInsensitive(headers, name);
  if (key) return;
  headers[name] = value;
}

/**
 * 中文说明：为渲染进程页面补齐“必须通过响应头才能生效”的安全策略。
 *
 * 背景：
 * - `frame-ancestors` 通过 `<meta http-equiv="Content-Security-Policy">` 会被 Chromium 忽略；
 *   因此需要在主进程通过 `webRequest.onHeadersReceived` 注入到响应头中，才能真正生效。
 *
 * 目前注入：
 * - `Content-Security-Policy: frame-ancestors 'none'`
 * - `X-Frame-Options: DENY`（兼容性兜底）
 */
export function installRendererResponseSecurityHeaders(targetSession: Session): void {
  if (!targetSession) return;
  if (installedSessions.has(targetSession)) return;
  installedSessions.add(targetSession);

  targetSession.webRequest.onHeadersReceived((details, callback) => {
    try {
      // 仅对文档响应注入，避免对脚本/图片等资源做无意义修改
      if (details.resourceType !== "mainFrame" && details.resourceType !== "subFrame") {
        callback({});
        return;
      }

      const next = cloneResponseHeaders(details.responseHeaders as ResponseHeaders | undefined);
      appendHeaderValue(next, "Content-Security-Policy", "frame-ancestors 'none'");
      setHeaderIfAbsent(next, "X-Frame-Options", "DENY");
      callback({ responseHeaders: next });
    } catch {
      // 防御性兜底：若注入失败，不应阻断页面加载
      callback({});
    }
  });
}
