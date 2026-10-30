# Agent Workspace

Agent Workspace helps you define AI coding tasks across multiple Git repositories in one VS Code workspace. It shows repository status, sends task context to GitHub Copilot Agent, and helps review subsequent Git changes. Repositories continue to use VS Code's native Explorer, Source Control, and diff views.

## Getting started

1. Open a VS Code workspace with one or more Git repositories. If VS Code shows **Restricted Mode**, trust the workspace if you know its source. Git status is unavailable while the workspace is restricted.
2. Open **Agent Workspace** in the Activity Bar. **Repositories** shows each root's branch, change count, and sync status.
3. Select **New Task** in **Task Workspace**. Enter a title and task content, then choose **Excluded**, **Read only**, or **Writable** for each workspace root. You can edit the task later by selecting its title or **Edit Task**.
4. Use **Add Scope Directory** to narrow a repository's scope. The directory must be inside that workspace root; symbolic links are checked against their resolved paths.
5. Use **Select AGENTS.md** to include project instructions. Select **Execute** to send the task, scope, and selected instructions to Copilot Agent. GitHub Copilot must be enabled and signed in. You can also copy the Markdown context or export task JSON.
6. Each successful **Execute** creates an **Execution Record** with the send time, task snapshot, repository scopes, and Git baseline. It tracks file changes observed afterward. **Stop Tracking Changes** freezes the record without stopping Copilot. **Open Copilot Sessions** opens Chat so you can find the session by task title and time. VS Code does not currently provide a stable direct link to the exact session.
7. Use **Git Change Review** to inspect current changes by repository. Select a file to open the native Git diff. The view marks pre-existing changes, later edits to the same file, scope warnings, and changed HEADs. Execution records retain historical paths and statuses even after a file becomes clean, when a Git diff may no longer be available.

## Explorer root icons

Right-click a workspace root in VS Code's native Explorer and select **Agent Workspace: Configure Explorer Root Icon**. You can also run the command from the Command Palette and select a root. Each root can use its own local image (PNG, JPEG, WebP, or GIF, up to 2 MB), emoji, or built-in icon. **Restore default** clears its setting. Uploaded images are copied into extension storage, so the original files can be moved or deleted.

The first icon change enables the **Agent Workspace Root Icons** theme for the workspace. Regular files and folders use VS Code Modern Icons. Saving an icon setting or updating the extension reloads the window once to apply the theme.

## Presets and data

Save the current task as a preset. **Apply Preset to Workspace Roots** asks for confirmation before replacing the workspace roots with the repositories included in that preset.

Tasks, presets, and execution records are stored in VS Code Workspace State. Execution records do not store Copilot conversations, instruction file contents, or full code diffs. When a task is created, it records repository HEADs and SHA-256 digests of existing changes. Rebuild the Git baseline after switching branches, resetting a repository, or changing HEAD.

Scope settings are guidance for the developer and agent; they do not change operating system or agent file permissions. Changes recorded after execution cannot be attributed to Copilot with certainty. Commit changes separately in each Git repository.

## Development

The extension uses the public API of VS Code's built-in Git extension and has no runtime dependencies. Run `npm run check` for syntax and behavior checks. Use VS Code's **Run Extension** launch configuration to debug it. Run `npm run package` to create a VSIX.

The file icon theme is based on VS Code Modern Icons. See [VSCODE_LICENSE.txt](media/theme/VSCODE_LICENSE.txt) for the license and attribution.
