# Comet Study Timer

一个运行在 Mac 上的本地学习时间记录工具。用计时器记录当下，用热力图回顾积累。

当前版本：**v1.4.0**。界面语言为英文，目前提供 Apple Silicon Mac 的应用包。

## 功能

- 学习计时、暂停、继续，以及手动补录。
- 为每次学习填写内容，查看时长和已知的起止时间。
- 年度学习热力图、每日目标和历史记录。
- 按月份查看历史，分页浏览记录，在有记录的日期之间切换。
- 在主页面继续最近一次计时保存的任务。
- 桌面组件：最近 12 周热力图和计时器，可拖动、置顶、折叠。
- 悬停折叠图标查看计时；右侧空间不足时向左展开，图标保持原位。
- 暖白与玫瑰金配色，以及 GitHub 风格的深色与绿色热力图。
- 本地自动备份、JSON 导入导出和最近操作的短时撤销。

## 使用

在 [Releases](https://github.com/rereva0611/CometStudyTimer/releases) 页面下载 `Comet-macOS-arm64-1.4.0.zip`，解压后将 `Comet.app` 放入“应用程序”。

主页面使用 `Start` 开始计时，`Pause / Resume` 暂停或继续，`Finish & save` 保存记录；`Log time` 用于补录。

关闭主窗口后，桌面组件继续运行。退出整个程序请使用 `Quit Comet`。休眠会自动暂停计时，唤醒后手动继续；锁屏时继续计时。

首次运行正式版会启用登录启动，可在菜单栏的 `Launch at login` 中关闭。

当前应用包采用本地 ad-hoc 签名，尚未完成 Apple Developer ID 签名和公证，其他 Mac 可能出现来源验证提示。Windows、Linux 和 Intel Mac 尚未验证。

## 数据与备份

无需账号，学习数据保存在本机：

```text
~/Library/Application Support/app.comet.studytime/
├── comet.sqlite3
├── widget-preferences.json
└── backups/
```

使用 `Export` 导出已保存的学习记录；使用 `Import` 导入兼容的 JSON 备份。进行中的计时需要先保存，才能包含在手动导出文件中。

自动备份可从应用菜单的 `File → Backups…` 查看和恢复。浏览器预览与桌面端分别保存数据，需要通过导出、导入迁移。

## 本地开发

需要 Node.js 的受支持 LTS 版本、Rust stable，以及 Xcode 或 Xcode Command Line Tools。环境配置可参考 [Tauri 官方文档](https://v2.tauri.app/start/prerequisites/#macos)。

在项目根目录执行：

```bash
npm ci
npm run tauri -- dev --config tauri.qa.conf.json
```

开发命令使用独立的 QA 应用标识，避免与正式版共用学习数据。QA 版本的登录启动功能禁用。

## 构建

```bash
npm run build
```

在 Apple Silicon Mac 上构建后，应用位于：

```text
src-tauri/target/release/bundle/macos/Comet.app
```

正式发布使用默认构建，不启用 `native-qa` 功能。发布包的签名和公证需要另行配置。

## 测试

```bash
npm test
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib
```

`ui-tests/` 包含浏览器界面回归测试，需要另外安装 Playwright，并在 macOS 的默认路径安装 Google Chrome；这些测试尚未包含在 `npm test` 中。

## 项目结构

```text
frontend/       HTML、CSS 和 JavaScript；主页面及桌面组件
src-tauri/      Rust、Tauri 配置、SQLite 存储与 macOS 原生交互
tests/          JavaScript 逻辑测试
ui-tests/       浏览器界面测试
```

依赖锁定文件 `package-lock.json` 和 `src-tauri/Cargo.lock` 随源码保留。

## 许可证

本项目采用 [MIT License](LICENSE)。Copyright (c) 2026 rereva0611。
