// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ScheduledMessage } from "@/types/host";

/** 订阅主进程预约，仅由拥有目标标签页的窗口领取并发送。 */
export function useScheduledMessages(send: (task: ScheduledMessage) => Promise<boolean>, canSend: (task: ScheduledMessage) => boolean) {
  const [tasks, setTasks] = useState<ScheduledMessage[]>([]);
  const handlers = useRef({ send, canSend });
  const processing = useRef(new Set<string>());
  useLayoutEffect(() => { handlers.current = { send, canSend }; });

  useEffect(() => {
    const api = window.host?.scheduledMessages;
    if (!api) return;
    let disposed = false;
    let receivedEvent = false;
    const unsubscribe = api.onChanged((next) => {
      receivedEvent = true;
      if (!disposed) setTasks(next);
    });
    void api.list().then((result) => {
      if (!disposed && !receivedEvent && result.ok) setTasks(result.tasks || []);
    }).catch(() => {});
    return () => { disposed = true; unsubscribe(); };
  }, []);

  useEffect(() => {
    /** 仅轮询本地到点快照，等待终端准备好，不重复跨进程传输长正文。 */
    function dispatchDue(): void {
      for (const task of tasks) {
        if (task.status !== "due" || processing.current.has(task.tabId) || !handlers.current.canSend(task)) continue;
        processing.current.add(task.tabId);
        /** 先领取再发送，且无论发送是否抛错都回报明确结果。 */
        const dispatch = async () => {
          const api = window.host.scheduledMessages;
          try {
            const claimed = await api.claim(task.id);
            if (!claimed.ok || !claimed.task) return;
            let success = false;
            try { success = await handlers.current.send(claimed.task); } catch {}
            await api.finish(task.id, success);
          } catch {} finally { processing.current.delete(task.tabId); }
        };
        void dispatch();
      }
    }
    dispatchDue();
    if (!tasks.some((task) => task.status === "due")) return;
    const timer = window.setInterval(dispatchDue, 1000);
    return () => window.clearInterval(timer);
  }, [tasks]);

  return tasks;
}
