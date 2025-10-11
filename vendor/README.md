将 ripgrep 二进制放在本目录，以便开发态与打包态均可使用：

推荐路径
- Windows: `vendor/bin/rg.exe`
- Linux/macOS（可选，便于跨平台开发）: `vendor/bin/rg`

说明
- 运行时优先搜索 `vendor/bin/rg(.exe)`；若不存在，再尝试 `resources/bin/rg(.exe)`、`build/bin/rg(.exe)`、`bin/rg(.exe)` 与系统 PATH。
- 打包时会将 `vendor/bin/**` 复制到应用资源目录 `resources/bin/**`，从而在安装包中自动可用。

获取 ripgrep（Windows x64）
- https://github.com/BurntSushi/ripgrep/releases 下载 `ripgrep-<version>-x86_64-pc-windows-msvc.zip`，解压得到 `rg.exe`，放到 `vendor/bin/rg.exe`。

