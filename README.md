# Obsidian Clawbar

A plugin that aims to replicate a native Claude Code chat UI, similar to the Visual Studio Code plugin.

![Obsidian clawbar screenshot](docs/images/screenshot.png)

## Installation

This plugin is not yet available in the official Obsidian community plugins directory. Install it manually:

### Manual Installation

1. Download the latest release from the [Releases](../../releases) page (`main.js` and `manifest.json`)
2. In your vault, create the folder `.obsidian/plugins/obsidian-clawbar/`
3. Move the downloaded files into that folder
4. Open Obsidian → **Settings** → **Community plugins**
5. Disable **Restricted mode** if it is enabled
6. Find **Clawbar** in the installed plugins list and toggle it on

### Install from Source

```bash
git clone https://github.com/bryanleetc/obsidian-clawbar
cd obsidian-clawbar
npm install
npm run build
```

Then copy `main.js` and `manifest.json` to `.obsidian/plugins/obsidian-clawbar/` in your vault and enable the plugin as described above.

## Features
- Native chat UI (not just a terminal wrapper)
- Multi-account support
- Awareness of current active note
- Polished permission and question prompts with smooth animations
- Interactive tool use visualization with collapsible sections
- Markdown rendering for assistant responses
- Conversation persistence across sessions