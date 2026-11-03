# Kangae Bar

A macOS menu-bar assistant for coding agents. Press **⌥Space** over any app and a floating bar appears: run and supervise Claude Code, Codex and Gemini CLI sessions by chat, approve their actions on **allow / always allow / deny** cards, and turn a repeated job into a one-press button. The same panel also runs as a Chrome side panel.

Built solo in under three weeks (Sept 28 – Oct 16, 2026). This repository is a snapshot of the latest tree; the 1,457-commit working history and internal notes stay private.

## What's here

| Path | What it is |
|---|---|
| `src/` | The resident daemon (TypeScript on Bun): agent sessions, approval rules, one-press jobs, peek |
| `bar/` | The floating bar (Swift: NSPanel + WKWebView, global hotkey, menu-bar item) |
| `extension/` | Chrome extension: side panel and new-tab desk |
| `test/` | ~1,500 tests (`bun test`) |
| `tools/`, `scripts/`, `exp/` | macOS Accessibility probes, build / sign / install scripts, experiments |

macOS only.
