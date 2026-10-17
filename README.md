<p align="center">
  <img src="apps/browser-extension/public/brand/lingo-sofa.svg" width="120" alt="LingoSofa logo">
</p>

<h1 align="center">LingoSofa</h1>

<p align="center">Read in two languages. Ask where you read.</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README-zh.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/ChenMiaoi/lingo-sofa/actions/workflows/ci.yml"><img src="https://github.com/ChenMiaoi/lingo-sofa/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue" alt="License: GPL-3.0-or-later"></a>
</p>

LingoSofa brings inline bilingual translation and contextual AI chat to webpages and Discord. Keep the original text in view, read the translation alongside it, and ask questions about the content you select. Both clients can share one local assistant and the same model accounts.

[Get started](#get-started) · [Releases](https://github.com/ChenMiaoi/lingo-sofa/releases) · [Documentation](#documentation) · [Report a bug](https://github.com/ChenMiaoi/lingo-sofa/issues)

> **Development preview.** The project has been tested with a real browser, Discord and model provider on macOS. Release CI targets five OS/CPU combinations; that does not mean every platform has completed client acceptance. Packages are currently unsigned. See [compatibility](docs/compatibility.md) and [release readiness](docs/release-readiness.md) for details.

## Features

- **Translate in place.** Translate a paragraph, selected text or Discord message without replacing the original. Enable automatic bilingual reading per website or channel.
- **Ask about what you read.** Open a conversation next to selected content to explain, summarize or draft a reply. Replies are yours to review and copy.
- **Choose your models.** Save multiple provider accounts and set separate defaults for translation and chat. Browser direct mode supports DeepSeek and OpenAI-compatible endpoints; the local assistant provides access through Pi.
- **Translate without an API key.** Choose Bing or Google in the browser and Discord. Bing is the default without model credentials; adding an account keeps your chosen free engine. Translation and Ask are configured independently. See [translation engines](docs/translation-engines.md).
- **Share one local assistant.** Browser and Discord reuse the same installation and model configuration on your computer, with separate content contexts.
- **See observed usage.** Inspect tokens, request history and estimated costs. Unknown usage stays unknown; interrupted requests are not automatically replayed.

## Get started

Visit [Releases](https://github.com/ChenMiaoi/lingo-sofa/releases) for downloadable builds. If no release is available yet, [build from source](#development).

| Component         | What to download                                          | How it is installed                                                                      |
| ----------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Browser extension | `lingo-sofa-browser-<version>.zip`                        | Enable developer mode and drag the ZIP onto the extensions page.                         |
| Discord plugin    | `lingo-sofa-vencord-<version>.tar.gz`                     | Add to a custom Vencord build. This is a userplugin, not a standalone Discord installer. |
| Local assistant   | `lingo-sofa-assistant-<version>-<platform>-<arch>.tar.gz` | Choose your OS/CPU, unpack and run the included installer. Node is bundled.              |

Assistant builds target macOS Apple Silicon / Intel, Linux ARM64 / x64, and Windows x64. Full installation, browser authorization and upgrade instructions are in the [installation guide](docs/installation.md).

### Browser

1. Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, and drag the browser ZIP onto the page. If your browser does not accept ZIP files, unpack it and choose **Load unpacked**.
2. Open LingoSofa settings. New browser installations connect directly to the translation service. To share accounts and engines with Discord, choose **Shared local assistant** and authorize your existing helper; download it only for a first installation.
3. Choose Bing or Google in **Translation preferences** to translate without a key. Add a provider account when you want model translation or Ask, and configure them independently.
4. Open a webpage and show the floating reader from the extension popup. Hover over a paragraph to translate, or select text for **Translate / Ask**. Press **Alt+Shift+A** to ask about selected content.

Automatic translation is enabled separately for each website. **Restore original** removes the inline translations.

### Discord

The desktop integration currently requires [Vencord](https://vencord.dev/). LingoSofa adds message translation, channel-level automatic reading and contextual chat. Custom plugins must be included in a custom Vencord build; the standard Vencord installer does not include LingoSofa.

Releases built with Windows installer support provide `LingoSofa-Setup-<version>-win32-x64.exe`: install the prebuilt Vencord integration and local assistant together, without a compiler or Node installation. Plugin settings offer checking, downloading and installing newer LingoSofa releases. Exit connected clients before installation; start Discord after installation to use the new version. See the [installation guide](docs/installation.md#windows-x64一体化安装与更新).

Once the plugin is enabled, it reuses an installed assistant or downloads and verifies the matching assistant package when the build includes a release manifest. Browser access still needs its own extension authorization. See [Discord installation](docs/installation.md#vencord-是否能省掉) for the assisted build/install workflow.

## Privacy and data

LingoSofa does not require a hosted LingoSofa backend. The local assistant listens only on `127.0.0.1`; clients on the same computer and OS account can share it. The assistant starts when needed and exits after clients disconnect and active work finishes.

Content you translate or send to chat goes to your chosen model provider. Automatic reading requires a website or channel opt-in. Browser and Discord content contexts remain separate even when they share model credentials, and sharing usage statistics is off by default.

Usage estimates describe requests observed by LingoSofa, not your entire provider bill. Subscription API-equivalent costs are estimates, not subscription charges. Read the [privacy guide](docs/privacy.md) and [authentication and billing notes](docs/oauth.md).

## Development

Use **Node.js 24** and npm. For packaging, use an official Node distribution so the assistant can include its runtime.

```sh
git clone https://github.com/ChenMiaoi/lingo-sofa.git
cd lingo-sofa
npm ci
npm run check
```

Load the built browser extension from `apps/browser-extension/.output/chrome-mv3`, or use `npm run dev` during development.

| Command                           | Purpose                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `npm run check`                   | Lint, formatting, types, tests, application builds and MV3 audit.                     |
| `npx playwright install chromium` | Install the browser needed for E2E tests.                                             |
| `npm run test:e2e`                | Run browser integration tests.                                                        |
| `npm run verify:vencord`          | Build and type-check with the pinned Vencord host; does not modify installed Discord. |
| `npm run setup:discord`           | Prepare a custom Vencord build containing LingoSofa.                                  |
| `npm run package:distribution`    | Build local distribution candidates for the current OS/CPU.                           |

To install the custom Vencord build into Discord, close Discord and explicitly run `npm run setup:discord -- --install`. This opens the upstream installer to select the client to modify.

Releases are built and published by version tags such as `v0.1.0`. See the [Release CI guide](docs/release-ci.md) for version checks, platform builds and immutable download checksums.

### Repository layout

```text
apps/
  browser-extension/   Chrome / Edge extension
  discord-vencord/     Discord integration
  pi-bridge/           Shared local assistant and installers
packages/              Translation core, protocols and shared components
docs/                  Design, setup and verification records
```

## Documentation

| Guide                                          | Contents                                                |
| ---------------------------------------------- | ------------------------------------------------------- |
| [Installation](docs/installation.md)           | Setup, authorization, upgrades and Vencord integration. |
| [Compatibility](docs/compatibility.md)         | Supported surfaces and current limits.                  |
| [Privacy](docs/privacy.md)                     | Content boundaries, credentials and retention.          |
| [Architecture](docs/architecture.md)           | Shared core, protocols and session isolation.           |
| [Service lifecycle](docs/service-lifecycle.md) | Startup, shared connections and shutdown.               |
| [Release CI](docs/release-ci.md)               | Tag-triggered builds and GitHub publishing.             |
| [Verification records](docs/acceptance.md)     | What has been tested and what remains.                  |

Most detailed technical documents are currently in Chinese.

## Contributing

Bug reports, reproducible examples and focused improvements are welcome. Start with an [issue](https://github.com/ChenMiaoi/lingo-sofa/issues) for substantial changes, and read the [contributor guidelines](AGENTS.md) before submitting a pull request. Include relevant checks and keep credentials and personal content out of reports.

LingoSofa builds on [Pi](https://github.com/earendil-works/pi), [WXT](https://github.com/wxt-dev/wxt) and [Vencord](https://github.com/Vendicated/Vencord). See [third-party notices](THIRD_PARTY_NOTICES.md) for their licenses.

## License

LingoSofa is licensed under **GNU GPL v3.0 or later** ([GPL-3.0-or-later](LICENSE)). Copyright © 2026 LingoSofa contributors.

Third-party components retain their own licenses. Vencord and Discord binaries are not included in the LingoSofa plugin archive; redistribution must preserve the applicable license, notice and source-code obligations.
