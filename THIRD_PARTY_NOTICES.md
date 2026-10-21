# Third-party notices

LingoSofa is GPL-3.0-or-later; see [LICENSE](LICENSE). It embeds oh-my-pi **18.12.3**, with the agent-core cancellation patch in `apps/omp-worker/patches`. Preserve the patch, `bun.lock`, `Cargo.lock` and corresponding source when distributing binaries.

The worker includes Bun **1.3.14** and the matching Windows x64 oh-my-pi native addon. The addon contains native upstream components. Its notices and the complete transitive dependency licenses must accompany a public release. This migration does not constitute a completed distribution-license audit.

Principal dependencies include Tauri 2 and its clipboard/global-shortcut/single-instance plugins, React, SQLite via rusqlite and Windows bindings. Their licenses remain those provided by upstream packages. WebView2 is a separately licensed Microsoft runtime.

The new app ships no Vencord host or original Pi 1.2.0 implementation. Before public release, generate and review complete bundled notices, include corresponding source, verify native component redistribution obligations and complete clean-machine installation acceptance. Current artifacts are development builds only.
