// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { afterEach, describe, expect, it, vi } from "vitest";
import { installRendererLifecycleLogging } from "./renderer-lifecycle-log";

describe("installRendererLifecycleLogging", () => {
  afterEach(() => {
    delete (window as any).__cf_renderer_lifecycle_log_installed__;
    delete (window as any).host;
    vi.restoreAllMocks();
  });

  it("重复安装时只注册一次生命周期日志监听", () => {
    const perfLogCritical = vi.fn().mockResolvedValue({ ok: true });
    (window as any).host = {
      utils: {
        perfLogCritical,
      },
    };
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: "navigate" }] as any);

    installRendererLifecycleLogging();
    installRendererLifecycleLogging();

    expect(perfLogCritical).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("beforeunload"));

    expect(perfLogCritical).toHaveBeenCalledTimes(2);
  });
});
