// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { HistoryFavoriteEntry } from "@/types/host";
import { createHistoryFavoriteMatcher, createHistoryFavoritesController } from "./favorites";

/** 管理收藏加载、乐观切换和持久化版本，供历史列表刷新分页与显示标记。 */
export function useHistoryFavorites(onError: (error: unknown) => void) {
  const [state, setState] = useState<{ entries: HistoryFavoriteEntry[]; revision: number }>({ entries: [], revision: 0 });
  const controllerRef = useRef<ReturnType<typeof createHistoryFavoritesController> | null>(null);
  const onErrorRef = useRef(onError);
  useLayoutEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => {
    let active = true;
    const controller = createHistoryFavoritesController(window.host.history, (entries, revision) => {
      if (active) setState({ entries, revision });
    }, (error) => {
      if (active) onErrorRef.current(error);
    });
    controllerRef.current = controller;
    return () => {
      active = false;
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, []);

  /** 使用控制器中的最新状态切换，避免同一渲染周期内重复点击读到旧快照。 */
  const toggleHistoryFavorite = useCallback(async (target: Parameters<ReturnType<typeof createHistoryFavoritesController>["toggle"]>[0]): Promise<void> => {
    await controllerRef.current?.toggle(target);
  }, []);
  const isHistoryFavorite = useMemo(() => createHistoryFavoriteMatcher(state.entries), [state.entries]);
  return { isHistoryFavorite, toggleHistoryFavorite, historyFavoritesRevision: state.revision };
}
