import type { HistoryMessage } from "@/types/host";

export type HistoryActivityGroup = {
  id: string;
  anchorIndex: number;
  messageIndices: number[];
  durationMs?: number;
};

export type HistoryActivityDisclosureState = HistoryActivityGroup & {
  expanded: boolean;
  visibleCount: number;
};

/** 判断内容是否属于执行过程，保留用户输入、文件改动和上下文压缩的独立入口。 */
function isActivityMessage(message: HistoryMessage): boolean {
  const role = message.role.toLowerCase();
  if (!["assistant", "tool", "function", "reasoning"].includes(role)) return false;
  return message.content.some((item) => ![
    "turn_diff", "context_compaction", "session_meta", "environment_context", "instructions", "user_instructions",
  ].includes(item.type.toLowerCase()) && String(item.text || "").trim().length > 0);
}

/** 只把真实用户正文作为轮次边界，子代理通知和开发者上下文不切断当前执行过程。 */
function isUserTurnBoundary(message: HistoryMessage): boolean {
  return message.role.toLowerCase() === "user" && message.content.some((item) => (
    ["input_text", "text", "image"].includes(item.type.toLowerCase())
    && !item.tags?.includes("developer")
  ));
}

/** 根据协议中的最终答复标记判断锚点；旧记录只将没有阶段标记的助手正文作为候选。 */
function isFinalAnswer(message: HistoryMessage): boolean {
  if (message.role.toLowerCase() !== "assistant") return false;
  const phase = String(message.phase || "").toLowerCase();
  if (phase && phase !== "final" && phase !== "final_answer") return false;
  return message.content.some((item) => ["output_text", "text"].includes(item.type.toLowerCase()));
}

/** 读取可靠的时间戳，非法或缺失时间保持未知，不把猜测当作耗时。 */
function timestampMs(message: HistoryMessage | undefined): number | undefined {
  if (!message?.timestamp) return undefined;
  const value = Date.parse(message.timestamp);
  return Number.isFinite(value) ? value : undefined;
}

/** 按用户轮次整理已完成的执行过程，最终答复与文件变更始终独立显示。 */
export function buildHistoryActivityGroups(messages: readonly HistoryMessage[]): HistoryActivityGroup[] {
  const groups: HistoryActivityGroup[] = [];
  let startIndex = 0;
  let turnId = "";

  /** 收束当前轮次；只有最终答复之前确实存在执行内容时才提供折叠入口。 */
  const flush = (endIndex: number): void => {
    let anchorIndex = -1;
    for (let index = startIndex; index < endIndex; index += 1)
      if (isFinalAnswer(messages[index])) anchorIndex = index;
    if (anchorIndex < 0) return;
    const messageIndices: number[] = [];
    for (let index = startIndex; index < anchorIndex; index += 1)
      if (isActivityMessage(messages[index]) && !messages[index].content.some((item) => item.type === "turn_diff"))
        messageIndices.push(index);
    if (messageIndices.length === 0) return;
    const anchor = messages[anchorIndex];
    const startedAt = timestampMs(messages[startIndex]) ?? timestampMs(messages[messageIndices[0]]);
    const completedAt = timestampMs(anchor);
    const measuredDuration = typeof anchor.durationMs === "number" && Number.isFinite(anchor.durationMs) && anchor.durationMs >= 0
      ? anchor.durationMs
      : startedAt !== undefined && completedAt !== undefined && completedAt >= startedAt
        ? completedAt - startedAt
        : undefined;
    groups.push({
      id: `${anchor.turnId || turnId || "legacy"}:${anchorIndex}`,
      anchorIndex,
      messageIndices,
      durationMs: measuredDuration,
    });
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const nextTurnId = message.turnId || "";
    if (index > startIndex && (isUserTurnBoundary(message) || (turnId && nextTurnId && turnId !== nextTurnId))) {
      flush(index);
      startIndex = index;
      turnId = "";
    }
    if (nextTurnId) turnId = nextTurnId;
  }
  flush(messages.length);
  return groups;
}

/** 应用折叠状态，始终把入口放在可展开内容之前；搜索时保留用户之前的展开选择。 */
export function resolveHistoryActivityVisibility<TView extends { originalIndex: number }>(
  views: readonly TView[],
  groups: readonly HistoryActivityGroup[],
  expandedIds: ReadonlySet<string>,
  searchActive: boolean,
): { messages: TView[]; disclosures: Map<number, HistoryActivityDisclosureState> } {
  const visibleIndices = new Set(views.map((view) => view.originalIndex));
  const hiddenIndices = new Set<number>();
  const disclosures = new Map<number, HistoryActivityDisclosureState>();
  for (const group of groups) {
    if (!visibleIndices.has(group.anchorIndex)) continue;
    const visibleActivity = group.messageIndices.filter((index) => visibleIndices.has(index));
    if (visibleActivity.length === 0) continue;
    const expanded = searchActive || expandedIds.has(group.id);
    const disclosureIndex = expanded ? visibleActivity[0] : group.anchorIndex;
    disclosures.set(disclosureIndex, { ...group, expanded, visibleCount: visibleActivity.length });
    if (!expanded)
      for (const index of visibleActivity) hiddenIndices.add(index);
  }
  return { messages: views.filter((view) => !hiddenIndices.has(view.originalIndex)), disclosures };
}

/** 将耗时显示为分秒或时分秒，避免长执行过程出现难读的大秒数。 */
export function formatHistoryActivityDuration(durationMs: number): string {
  const seconds = Math.floor(Math.max(0, durationMs) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const tail = `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : tail;
}
