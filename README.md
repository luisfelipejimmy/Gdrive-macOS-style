# GDrive macOS style

[![Release](https://img.shields.io/github/v/release/luisfelipejimmy/Gdrive-macOS-style)](https://github.com/luisfelipejimmy/Gdrive-macOS-style/releases/latest)
[![License: MIT](https://img.shields.io/github/license/luisfelipejimmy/Gdrive-macOS-style)](LICENSE)
[![Stars](https://img.shields.io/github/stars/luisfelipejimmy/Gdrive-macOS-style?style=flat)](https://github.com/luisfelipejimmy/Gdrive-macOS-style/stargazers)
[![Issues](https://img.shields.io/github/issues/luisfelipejimmy/Gdrive-macOS-style)](https://github.com/luisfelipejimmy/Gdrive-macOS-style/issues)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](extension/manifest.json)

A Chrome extension that adds a **Finder-style column view** to Google Drive.
It uses no API and no credentials: it reads items from Drive's own list and forwards selection, menus and shortcuts
to the native list, which keeps running (hidden) underneath the columns.

![GDrive macOS style: Google Drive in Finder-style column view](docs/screenshot.png)

## Installation

Open `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → select the `extension/` folder.
Open Drive and click the **Columns** button next to List/Grid.

## Features

- Drive's sidebar, header (with the folder path) and **New** button stay intact
- Column navigation with mouse and keyboard; resizable columns (⌥ = all of them)
- Preview (real thumbnail) + file info
- Drive's **native** selection bar, context menu, dialogs and viewer
- **Opening a folder from its URL**: an option in the extension's settings (`chrome://extensions` → GDrive macOS style → **Details** → **Extension options**). *Only the folder* (default, like Finder) shows just that folder's column; *Full path* also shows every folder above it, including the ones hidden behind "…" in the breadcrumb. Turning Columns on and navigating inside Drive always show the full path. *Full path* takes a few seconds on deep folders, because the extension has to open each folder above to read it
- Large folders are loaded in full automatically (Drive pages them 50 at a time)
- **Drag and drop**: move items between columns and upload files dragged from your computer (details below)
- Works in: My Drive, folders, Shared with me, Recent, Starred, Trash, Shared drives, Computers and search

## Keyboard shortcuts

| Key | Action |
|---|---|
| ↑ ↓ ← → | navigate |
| letters | jump to an item by name |
| Space | preview (Drive's viewer) |
| ⌘O / ⌘↓ / double-click | open |
| Enter | rename (Drive's dialog) |
| ⌘⌫ / Delete | move to trash |
| ⌘C, then ⌘V | make a copy (Drive's; Drive has no cut) |
| ⌥⌘ + key | Drive shortcuts (⌥⌘A share, ⌥⌘M move, ⌥⌘S star…) |
| ⌘A, ⌘/Shift + click | multiple selection |

## Drag and drop

| Gesture | Result |
|---|---|
| Drag item(s) onto a folder in any column | moves them into that folder |
| Drag onto the empty area of a column | moves them into that column's folder |
| Hover ~1 s over a folder while dragging | opens the folder (like Finder's "spring-loaded" folders) |
| Drag files from your computer onto a column or folder | uploads them to that folder (Drive upload) |
| Drag an item to another app or tab | drops the file's link |

- Dragging a selected item takes the whole selection; an unselected item goes alone.
- A folder can't be moved into itself, and dropping onto the folder the item is already in does nothing.
- Not available in Trash and Computers.

**How moving works:** Drive has no cut/paste (⌘C → ⌘V only makes a copy), and dragging in the native list
only moves to folders visible in that same list. Anywhere else it **creates a shortcut** instead of moving.
So the extension uses Drive's **Move** dialog (⌥⌘M): it selects the items in the native list, opens the dialog,
pastes the destination folder's URL into its search box and clicks "Move" on the folder's row. The dialog works
**invisibly and without blocking clicks**. Meanwhile the items are dimmed and a "Moving…" label appears at the bottom
of the columns: under 1 s, or about 3–5 s the first time after the page loads. At the end Drive shows its toast
with **Undo**. If Drive asks a question in the dialog, the dialog becomes visible again.

**How uploading works:** while files are dragged over the columns, the native list already opens the destination
folder and receives `dragenter`/`dragover`. On drop, the `drop` event is forwarded to it, and Drive uploads with its
progress panel in the bottom-right corner. If `dragover` and `drop` arrive at the same instant, Drive uploads but
hides the panel, so the two are delivered at different moments.
If the folder hadn't opened yet, the files are uploaded as soon as it does. In that case folders dragged from the
computer don't go through (the browser only hands over their contents during the "drop" itself), and a notice asks you to drop again.

## How it works

| Piece | Detail |
|---|---|
| Data | `tr[role=row][data-id]` rows from the native list; type comes from `aria-label`, icons are cloned. In Computers, `div[role=gridcell][data-id]` cards |
| Navigation | `history.replaceState` + `popstate` makes Drive open the folder without reloading |
| Actions | clicks, context menu and keys are dispatched on the matching native row |
| Move | Move dialog (`iframe` `/picker/minpick`, same origin): `tr[data-target-folder-id]` rows and search by folder URL |
| Upload | `dragenter`/`dragover`/`drop` forwarded to the native list's `[role=grid]` |
| Layers | columns at `z-index: 5` — above the list (context 0), below Drive's menus (8) |

## Protection against Google changes

The extension depends on Drive's internal HTML. In **My Drive and folders**, it constantly checks that what it needs still exists.
If something fails, the columns **turn themselves off**, a notice appears and Drive's normal list comes back. Clicking **Columns** tries again.

| Check | Turns off when |
|---|---|
| File area (`div[role=main]`) | missing for 15 s |
| List/Grid buttons (`button[data-test-id="list-layout-button"]`) | missing for 8 s (without them there'd be no way to turn the columns off) |
| List rows (`tr[role=row][data-id]`) | items are on screen but none in this format, for 6 s |
| URL navigation | Drive fails to open two folders in a row |
| The extension's own errors | 5 errors in 20 s |

The reason is logged to the console (`[GDrive macOS style]`) and set on `<html data-gdf-health="…">` (`ok` when all is well).

## Self-test

Open **https://drive.google.com/drive/my-drive#gdf-teste**. Within a few seconds the extension opens My Drive, turns on the columns,
enters a folder and a subfolder, and shows a panel with what passed (✓) and what broke (✕), step by step.
If the columns were off, it turns them off again at the end.

To automate it: dispatch `document.dispatchEvent(new Event('gdf-selftest'))` on the page and wait for
`<html data-gdf-test>` to become `ok` or `falhou` (failed); the full report is in `data-gdf-test-report` (JSON).

## Limitations

- Depends on Drive's internal HTML; when Google changes it, the protection above turns the columns off and the self-test shows what needs fixing.
- Each new column takes as long as Drive needs to open the folder (~0.5 s).
- Drag-to-move depends on Drive's Move dialog; if it changes, a notice appears and the fallback is Move (⌥⌘M) from the menu.
- The "Home" section stays in the native view.
- In Computers, Drive doesn't show the List/Grid buttons, so the Columns button doesn't appear there either: columns stay on or off according to the rest of Drive.

## Roadmap

See [roadmap.md](roadmap.md).
