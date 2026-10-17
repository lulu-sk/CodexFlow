import { useCallback, useLayoutEffect, useRef } from "react";

/** 为当前环境的异步请求排序，环境切换或卸载后丢弃旧结果。 */
export function useLatestRequest(scope: string): () => () => boolean {
  const current = useRef({ scope, generation: 0, mounted: false });

  useLayoutEffect(() => {
    if (current.current.scope !== scope) current.current.generation += 1;
    current.current.scope = scope;
    current.current.mounted = true;
    return () => {
      // 严格模式会对同一挂载重放副作用，此处只标记卸载，不取消仍可复用的请求。
      current.current.mounted = false;
    };
  }, [scope]);

  /** 开始一次请求，并返回结果仍属于当前请求的检查方法。 */
  return useCallback(() => {
    const generation = ++current.current.generation;
    return () => current.current.mounted
      && current.current.scope === scope
      && current.current.generation === generation;
  }, [scope]);
}
