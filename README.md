<p align="center">
  <img src="apps/desktop/public/brand/lingo-sofa.svg" width="120" alt="LingoSofa logo">
</p>

<h1 align="center">LingoSofa</h1>

<p align="center">Read in two languages. Ask where you read.</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README-zh.md">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Windows_11-x64-555555" alt="Windows 11 x64">
  <img src="https://img.shields.io/badge/status-development_preview-555555" alt="Development preview">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue" alt="License: GPL-3.0-or-later"></a>
</p>

LingoSofa is a floating translator for Windows. Select text, read its translation nearby, and open Ask to explore what it means. Input translation and independent questions share the same lightweight panel, ready when you need them.

[Preview](#preview) · [Get started](#get-started) · [Documentation](#documentation) · [Report a bug](https://github.com/ChenMiaoi/lingo-sofa/issues)

> **Development preview.** The current desktop app targets Windows 11 x64, and installers are unsigned. Browser selection acceptance is still pending; screenshot OCR, additional providers and OAuth are not yet available. See the [compatibility and acceptance status](docs/acceptance.md) for tested applications and remaining work.

## Preview

**Translate or ask, in one place.** A compact charcoal glass panel for text you want to understand.

<p align="center">
  <img src="assets/screenshots/input-panel.png" width="620" alt="LingoSofa's translucent dark input panel with translation and independent question actions">
</p>

<details>
<summary>See global shortcut settings</summary>

**Keep your shortcuts close.** Change each combination, check whether it is enabled, and restore the defaults when needed.

<p align="center">
  <img src="assets/screenshots/shortcut-settings.png" width="550" alt="LingoSofa global shortcut settings with all three default combinations enabled">
</p>

</details>

Screenshots show the native Windows desktop application using an isolated test profile without a configured model account.

## Features

- **Translate selected text.** Read a translation beside your selection. The original text stays in its application, and the lightweight translation collapses when its source moves out of place.
- **Ask about what you read.** Keep the selected source in context, stream a reply, and continue asking questions. You can stop generation or manually compact the conversation.
- **Translate what you type or copy.** Open the input panel for translation or an independent question, or explicitly translate the current clipboard text.
- **Make shortcuts your own.** Open the panel from another application, change all three global bindings, and keep them across restarts. Conflicts are reported before replacing the previous configuration.
- **Use your own model account.** Connect a DeepSeek API Key for DeepSeek V4.1 Flash. Credentials are encrypted for your Windows user account.
- **See observed usage.** Track reported tokens and incomplete usage. Unknown usage stays unknown, and interrupted requests are not automatically replayed.

## Get started

There is no published desktop release yet. [Build from source](#development) to generate a Windows installer; installed users do not need Bun or Rust. Setup and usage details are in the [installation guide](docs/installation.md).

1. Start LingoSofa and open **Settings** from the edge entry or system tray.
2. Add your DeepSeek API Key and choose a target language.
3. Select text and translate it, or open the input panel to translate or ask a new question. Open **Ask** from a translation to continue with its source context.

| Default shortcut    | Action                                             |
| ------------------- | -------------------------------------------------- |
| **Alt+Shift+Space** | Open input translation or an independent question. |
| **Alt+Shift+S**     | Translate the current text selection.              |
| **Alt+Shift+T**     | Translate clipboard text.                          |

Change these combinations under **Settings → Global shortcuts**. Save to apply them immediately; if registration fails, the previous configuration remains in effect. The edge entry and tray remain available.

Inside the input panel, **Enter** runs the selected action, **Shift+Enter** inserts a new line, **Alt+↑↓** switches actions, and **Esc** returns to reading. Reopening an already open input panel with its shortcut preserves the draft.

Selection support depends on the source application. Notepad, an isolated VS Code instance with accessibility enabled, and Discord message text have completed scoped checks. Browser selection remains unverified; use the [manual checklist](docs/browser-manual-acceptance.md) to test it.

## Privacy and data

LingoSofa runs locally and does not require a hosted LingoSofa backend. Text you submit for translation or questions, along with the conversation context needed for replies and compaction, goes to DeepSeek using your account.

Clipboard text is read only when you explicitly request a translation. Source text, translations and conversations stay in memory; credentials are encrypted locally, and the usage ledger stores call metadata without message bodies or keys. There is no telemetry or automatic replay of failed requests.

Reported usage describes calls observed by LingoSofa, not your entire provider bill. Cancelling a request cannot guarantee that the provider stops billing it. Read the [privacy guide](docs/privacy.md) for details.

## Development

macOS (Apple Silicon and Intel) build instructions, platform differences, and validation limits: [development guide](docs/development.md#macos).

Runtime checks also require [cargo-nextest](https://nexte.st/docs/installation/pre-built-binaries/) 0.9.149. CI installs the pinned prebuilt tool; local installation from crates.io: `cargo install cargo-nextest --version 0.9.149 --locked`.

On Windows x64, use **Bun 1.3.14**, **Node.js 24**, **Rust 1.98.1 MSVC**, Visual Studio C++ Build Tools and WebView2. From the project directory:

```powershell
bun install --frozen-lockfile
npm run dev
```

The development command builds the private worker and selection helper, then starts the frontend and desktop app.

| Command                         | Purpose                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `npm run dev`                   | Start the desktop development environment.                                    |
| `npm run check`                 | Run lint, formatting, types, regressions, Rust checks and application builds. |
| `npm run test:runtime:packaged` | Test the Rust runtime with a compiled worker.                                 |
| `npm run test:sdk`              | Run the isolated SDK probes.                                                  |
| `npm run build`                 | Build the Windows NSIS installer.                                             |

Release installers are generated in `target/release/bundle/nsis`. For a debug installer, run `bun scripts/desktop.ts build --debug`; output goes to `target/debug/bundle/nsis`.

Normal checks use local simulated services. The explicit `verify:live` and `verify:live:dual` scripts read `API_KEY` from an ignored local `.env` and incur real provider usage. They use an isolated profile and do not configure the desktop account.

### Repository layout

```text
apps/
  desktop/       React interface and Tauri Windows application
  omp-worker/    Embedded oh-my-pi model and session worker
crates/          Rust application services, scheduling and system adapters
tests/           UI, SDK and process integration regressions
docs/            Product design, setup and contributor guides
```

## Documentation

| Guide                                              | Contents                                       |
| -------------------------------------------------- | ---------------------------------------------- |
| [Installation](docs/installation.md)               | Setup, everyday use and shortcut settings.     |
| [Privacy](docs/privacy.md)                         | Content boundaries, credentials and retention. |
| [Architecture](docs/architecture.md)               | Desktop components, processes and storage.     |
| [Compatibility and acceptance](docs/acceptance.md) | Tested workflows and remaining acceptance.     |
| [Technical plan](docs/lingo-sofa-plan.md)          | Product direction and planned capabilities.    |

Most detailed technical documents are currently in Chinese.

Development commands, CI reports and platform details: [Development guide](docs/development.md).

## Contributing

Bug reports, reproducible examples and focused improvements are welcome. Start with an [issue](https://github.com/ChenMiaoi/lingo-sofa/issues) for substantial changes, and read the [contributor guidelines](AGENTS.md) before submitting a pull request. Include relevant checks and keep credentials and personal content out of reports.

LingoSofa builds on [Tauri](https://github.com/tauri-apps/tauri), [React](https://github.com/facebook/react) and [oh-my-pi](https://github.com/can1357/oh-my-pi). See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency and distribution requirements.

## License

LingoSofa is licensed under **GNU GPL v3.0 or later** ([GPL-3.0-or-later](LICENSE)). Copyright © 2026 LingoSofa contributors.

Third-party components retain their own licenses. Redistribution must preserve the applicable license, notice and source-code obligations.
