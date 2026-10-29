# Agent Workspace

一个面向多根 VS Code 工作区的任务范围与 Git 审阅扩展。每个仓库仍使用 VS Code 原生 Explorer、Git SCM 和 diff。

## 使用

1. 在 VS Code 中打开包含多个 Git 仓库的工作区。
   若状态栏显示 **Restricted Mode**，VS Code 不提供 Git SCM；请在确认仓库来源可信后自行信任该工作区，才能看到分支和改动。
2. 点击 Activity Bar 的 **Agent Workspace**。仓库总览显示分支、改动数量及同步状态。
3. 在任务工作台点击 **新建任务**，填写标题和多行任务内容，并为每个工作区根目录选择“未纳入 / 只读 / 可改”。保存后点击任务标题或“编辑任务”可再次修改。
4. 用 **添加范围目录** 缩小某个仓库的范围。目录必须位于该工作区根目录内；符号链接会按实际路径检查。
5. 用 **选择 AGENTS.md** 确认纳入的项目约定。点击 **执行** 将任务内容、范围与约定提交给 VS Code 中的 Copilot Agent；需要已启用并登录 GitHub Copilot。也可复制 Markdown 上下文包或导出 JSON。
6. 成功提交 **执行** 后，**执行记录** 会保存发送时间、任务内容快照、仓库范围和 Git 基线。记录会持续收集随后观察到的文件改动；点击“停止记录改动”可冻结这一条记录，但不会停止 Copilot。记录里的“打开 Copilot 会话列表”会打开 VS Code 聊天，你可以按任务标题和时间找到对应会话。当前没有稳定的会话直达链接。
7. 在 **Git 变更审阅** 中按仓库查看当前改动。点击文件打开 VS Code Git 差异。建任务前已有改动、同一文件进一步变更、超出可改范围、HEAD 变化会分别标记。执行记录中的历史文件即使后来变干净，仍会保留路径和状态；这时可能没有可打开的 Git diff。

## Explorer 根目录图标

在 VS Code 原生 Explorer 中右键点击工作区根目录（例如 Core、Pro、Cloud、Test），选择 **Agent Workspace: 设置 Explorer 根目录图标**。也可从命令面板运行同名命令，再选根目录。每个根目录可独立使用本地图片（PNG/JPEG/WebP/GIF，最大 2 MB）、emoji 或内置图标；选择“恢复默认”可清除配置。上传的图片会复制到扩展的本地存储，原文件可以移动或删除。首次设置会为当前工作区启用 **Agent Workspace 根目录图标** 主题；普通文件和文件夹使用 VS Code Modern Icons 图标。保存图标配置或更新扩展时，窗口会自动重载一次以应用图标。

可将当前任务保存为预设。预设的菜单中有“将预设应用到工作区根目录”，执行前会显示确认框，并将工作区根目录调整为该预设纳入的仓库。

任务、预设和执行记录保存在 VS Code Workspace State 中。执行记录不保存 Copilot 对话、约定文件正文或完整代码 diff。任务建立时记录仓库 HEAD 与已有改动的状态及 SHA-256 内容摘要。分支切换、reset 或 HEAD 变化后，请在任务工作台重建 Git 基线。

范围是给人和智能体的声明与审阅提示，不会改变操作系统或智能体的实际文件权限。执行记录中的文件变化只是发送后观察到的结果，不能证明全部由 Copilot 产生。每个 Git 仓库仍需独立提交。

## 开发

本扩展使用 VS Code 内置 Git 扩展的公开 API，无运行时依赖。运行 `npm run check` 检查语法和范围/基线判定。可通过 VS Code 的“运行扩展”开发配置调试。

文件图标主题基于 VS Code Modern Icons，版权与许可见 [VSCODE_LICENSE.txt](media/theme/VSCODE_LICENSE.txt)。
