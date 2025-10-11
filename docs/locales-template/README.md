# 本地化模板使用说明

此目录提供一套英文基线（en）的多语言 JSON 模板，方便开发者与非开发者扩展新语言。

## 放置位置

- 开发者（参与代码仓库）：
  - 将 `en/` 拷贝为新语言目录，例如 `web/src/locales/ja/`
  - 修改各 JSON 的值为目标语言
  - 运行 `npm run i18n:report` 查看与英文基线的键差异

- 非开发者（无需修改代码/打包）：
  - Windows：`%APPDATA%/codexflow/locales/<lng>/`
    - 例：`C:\\Users\\you\\AppData\\Roaming\\codexflow\\locales\\ja\\`
  - WSL 对应：`/mnt/c/Users/you/AppData/Roaming/codexflow/locales/ja/`
  - 将本目录 `en/` 拷贝到上述路径并重命名为 `<lng>`，修改 JSON 译文后，重新打开设置页即可在语言下拉中看到并选择。

## 命名空间

- common、settings、projects、terminal、history、at
- 保持 JSON 键结构与英文基线一致；ICU 插值示例：`{ ok } { notFound } { failed }`

## 验证

- 应用内设置页选择新语言，或在 DevTools 中执行：`await window.host.i18n.setLocale('<lng>')`
- 若某键缺失，会回退到英文，且不会显示为空字符串。

