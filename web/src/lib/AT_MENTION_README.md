# @ 搜索弹窗（接入说明）

本说明介绍如何在 CodexFlow 前端接入基于 `@` 的两级搜索弹窗（仅 UI 壳），以及接入真实数据时需要关注的点。

## 总览
- 触发：输入框内键入 `@`（前一字符为空白/行首/标点）立即弹出“一级分类”。继续输入任意字符，自动切到“二级搜索（All）”。
- 范围：
  - 未进入分类：全局搜索（All）→ 允许各分类结果同时出现；
  - 进入分类：仅搜索该分类。
- 交互：↑/↓ 移动高亮；Enter 在一级进入分类、在二级选中；Esc 二级→一级→关闭；点击外部关闭（不改动文本）。
- 替换：选中后仅替换从最近一个 `@` 到光标处的查询段（`@xxxxx`），光标置于替换文本之后。
- 展示：最多 30 条，无动画；固定尺寸，避免内容过少时出现大块留白；智能定位，避免遮挡。

## 目录与模块
- 组件
  - `web/src/components/at-mention-new/CommandInputWithAt.tsx`（导出 `AtInput`）：包裹基础 `Input`，处理触发、替换、与弹窗交互。
  - `web/src/components/at-mention-new/AtCommandPalette.tsx`：两级弹窗（Categories/Results）。
  - `web/src/components/at-mention-new/caret.ts`：计算 caret 视口坐标用于定位。
- 搜索与类型
  - `web/src/lib/atSearch.ts`：`AT_CATEGORIES`、`MOCK_ITEMS`、`searchAtItems()`（含简易模糊/前缀/路径段评分与目录优先）。
  - `web/src/types/at.ts`：`AtCategory`、`AtItem`、`SearchScope` 等基础类型定义。

## 在页面中使用
```tsx
import AtInput from "@/components/at-mention-new/CommandInputWithAt";

// 替换原 Input（props 基本一致，事件名为 onValueChange）
<AtInput
  multiline
  value={cmd}
  onValueChange={setCmd}
  placeholder="在此输入信息…"
  className="pr-12"
/>
```
- `AtInput` 内部仍渲染 `Input`，因此样式/大小与现有一致（当前默认宽度 540，结果区高度 250，分类区高度 160；小屏会按视口自适应收缩）。

## 接入真实数据（替换 Mock）
当前 `searchAtItems()` 使用 `MOCK_ITEMS`。接入真实数据时，建议按以下最小改动路径：
1. 在 `atSearch.ts` 中引入你的数据源，并映射为 `AtItem[]`：
   - Files & Folders：将索引结果映射为 `{ id, categoryId: 'files', title(文件名), subtitle(相对路径), path, isDir }`；
   - Rule：将规则映射为 `{ id, categoryId: 'rule', title(规则名), subtitle(分组) }`。
2. 将 `MOCK_ITEMS` 替换为来自数据源的拼接结果（或在函数内按 `scope` 分开读取，以避免不必要的全量加载）。
3. 如需区分“文件/目录优先级”“路径段匹配”等策略，可在 `scoreFile()/scoreRule()` 中微调评分规则（已内置：前缀>模糊>路径段>更短路径；全局含 `/` 时目录加权）。
4. 结果数量请保持 `limit=30` 上限不变。

> 接入来源示例：
> - 读取项目索引/缓存；
> - 通过 `window.host.*` IPC 从主进程查询（注意渲染进程安全：`contextIsolation: true`，仅用 preload 提供的 API）。

## 自定义行为与扩展
- 进入新分类：在 `AT_CATEGORIES` 中新增条目，并确保你的数据映射产出对应 `categoryId` 的 `AtItem`。
- 选中后的业务联动：当前默认“仅替换文本”。如需额外动作（如跳转/打开文件），可在 `AtInput` 的 `handlePick` 内扩展；或将其重构为支持外部回调（例如 `onPickItem`）。
- 主题与尺寸：
  - 默认宽度 `540px`（相较 360 提升 1.5 倍，且会按视口自适应收缩）；分类高度 `160px`、结果高度 `250px`；
  - 若下方空间不足自动上翻；左右贴边距 8px。

## 行为细节（校验点）
- `@` 立即弹出一级；继续键入即进入 All；删除回到仅 `@` 时返回一级。
- 在 All 中可同时看到不同分类的命中；在分类内仅显示该类。
- 仅替换 `@xxxxx` 段，其余文本保持不变；Esc/点击外部不改变输入框内容。

## 常见问题
- IME/组合输入下没有即时弹出？→ 已在 `AtInput` 监听原生 `input` 事件，确保即时检测。
- 弹窗被遮挡？→ 采用智能定位与固定尺寸，默认下方，不足时上翻并夹紧左右边界。
- 查询不同步（如输入 `bac` 显示 `ba`）？→ 已将主输入与面板输入做同步展示策略，全局只读但完整显示；分类内可编辑。

---
如需将评分/排序或 UI 风格进一步对齐你的实际数据，请说明具体期望（例如目录优先级、规则分组权重），我可以在 `atSearch.ts` 中细化策略。
