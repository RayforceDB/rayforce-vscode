# :material-newspaper: Changelog

All notable changes to RayforceDB VS Code Extension will be documented in this file.

!!! note ""
    You can also subscribe for release notifications by joining our [:simple-zulip: Zulip](https://rayforcedb.zulipchat.com/#narrow/channel/549008-Discuss)!


## **`0.5.2`**

- Large REPL results are now counted and truncated on the server, so previewing a big vector no longer sends the whole thing over the wire
- Fixed I64 nulls rendering as `-9223372036854775808` instead of `0N`
- Fixed stale text staying visible in the REPL input after a command was submitted
- Connection state is now updated only after the REPL actually connects, and a failed connect surfaces an error instead of leaving the instance marked connected
- Clicking an already-connected saved instance now opens its REPL instead of reconnecting
- Fixed saving or moving an instance into the wrong folder when two folders share the same name
- Process Info now escapes the remote instance label, and malformed drag-and-drop payloads in Saved Instances are ignored instead of raising errors

2026-07-29 | **[🔗 VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=RayforceDB.rayforce-vscode)** | **[🔗 GitHub](https://github.com/RayforceDB/rayforce-vscode/releases/tag/0.5.2)**


## **`0.5.1`**

- Fixed concurrent REPL commands corrupting each other's output — requests to an instance are now serialized through a queue so each command reliably receives its own result
- Connecting to an authenticated instance now prompts for a username in addition to a password
- Environment panel now surfaces load errors instead of silently showing blank, and its refresh/toggle controls work under the webview Content Security Policy

2026-07-25 | **[🔗 VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=RayforceDB.rayforce-vscode)** | **[🔗 GitHub](https://github.com/RayforceDB/rayforce-vscode/releases/tag/0.5.1)**


## **`0.5.0`**

- Added support for Rayforce wire protocol v3
- REPL now shows the actual remote host in the panel title and status bar
- Fixed rendering of pre-2000 (negative) timestamps

2026-07-20 | **[🔗 VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=RayforceDB.rayforce-vscode)** | **[🔗 GitHub](https://github.com/RayforceDB/rayforce-vscode/releases/tag/0.5.0)**


## **`0.4.1`**

- Visual improvements to the Marketplace page

2025-01-25 | **[🔗 VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=RayforceDB.rayforce-vscode)** | **[🔗 GitHub](https://github.com/RayforceDB/rayforce-vscode/releases/tag/0.4.1)**


## **`0.4.0`**

- Enhanced instance manager with folder organization for saved instances
- Fixed deserialization issues with Time Date and Timestamp types in Typescript IPC
- Improved REPL integration with environment variable inspection
- Added custom file icons for `.rfl` and `.rf` files
- Added full Rayfall language support with syntax highlighting and autocomplete

2025-01-25 | **[🔗 VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=RayforceDB.rayforce-vscode)** | **[🔗 GitHub](https://github.com/RayforceDB/rayforce-vscode/releases/tag/0.4.0)**

