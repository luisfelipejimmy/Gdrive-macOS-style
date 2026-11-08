# Roadmap — GDrive macOS style

List compiled on 2026-11-02, in suggested priority order.

## 1. Protection against Google changes (priority)

The extension depends on Drive's internal HTML, which Google changes without notice.

- [x] **Check on load:** verify the expected elements exist (`button[data-test-id="list-layout-button"]`, `div[role="main"]`, `tr[role="row"][data-id]`). If something disappears, turn the columns off automatically with a notice instead of breaking Drive.
- [x] **Simple automated test:** open Drive, turn on the columns, navigate two folders. Shows within seconds what broke when Drive changes.

  Done: the check runs only in My Drive and folders (Computers has no List/Grid buttons). Self-test at `…/drive/my-drive#gdf-teste`; details in the README.

## 2. Bring back drag and drop

- [x] **Move between columns:** dropping an item on a folder would become "cut (⌘X) → open destination folder → paste (⌘V)" in the native list. First, test whether Drive has cut/paste, using a throwaway file.

  Done, a different way. Tested with throwaway files: Drive **has no cut** (⌘C → ⌘V only makes a copy).
  Dragging in the native list only moves to folders visible in that same list, and elsewhere it creates a **shortcut** instead of moving.
  The extension uses the **Move** dialog (⌥⌘M): it pastes the destination folder's URL into the dialog's search and clicks "Move".
  Works for any folder in the columns, with multiple selection, spring-loading (hovering opens the folder) and Drive's "Undo".
- [x] **Upload files dragged from the computer:** drop files on a column and forward them to that folder's native list.

  Done: the native list opens the destination folder while files are dragged over it, and the "drop" is forwarded to it.
  Tested with script-generated files (column, folder in another column and immediate drop).
  **Still needs testing by dragging from the real Finder**, especially a whole folder.

## 3. More speed

- [ ] Cache the contents of visited folders while the tab is open: after reloading the page, the columns appear instantly and refresh in the background.
- [ ] Preload the selected folder when the user rests on it with the arrow keys.

## 4. Missing Finder features

- [ ] **Back/forward:** ⌘[ and ⌘] for folder history.
- [ ] **"Show in location" in search:** build the columns with the path to the found file.
- [ ] **Richer preview:**
  - [ ] play video and audio in the panel itself
  - [ ] scroll through PDF pages
  - [ ] bring in more data from Drive's ⓘ panel (location, who has access, creation date)
- [ ] **Path bar at the bottom**, like Finder's, with the item count.

## 5. Validate what hasn't been tested yet

- [ ] Dark theme
- [ ] Shared drives
- [ ] Shortcuts pointing to folders
- [ ] Empty folder
- [ ] Drive in English
- [ ] Second signed-in account (`/u/1/` URL)
- [x] **Computers shows up empty in the columns:** in this section Drive doesn't use `tr[role="row"][data-id]` rows and has no List/Grid buttons, so the columns find no items. Look at how Drive builds this list and read items from there (or leave Computers in the native view).

  Done: in Computers the columns read the `div[role="gridcell"][data-id]` cards; each computer opens as a folder. When opening a computer folder by URL, the path starts at the "Computers" column (breadcrumb with `data-view="…computers…"`). Tested: list, opening the computer, context menu and full path to `Documents`.
- [ ] Keys that modify files: Delete/⌘⌫ (trash), ⌘C/⌘X/⌘V. Test with throwaway files.
  (Drive's menu shows "Make a copy: ⌘C, then ⌘V" and has no cut; in the test with simulated keys, ⌘X → ⌘V moved nothing.)
- [x] **Path when opening by URL (design decision):** when loading the page directly into a subfolder, only that folder's column appears,
  without its ancestors. This matches Finder (jumping straight to a folder shows just that column), so it is not a bug.
  Toggling the columns off and on builds the full path. Seen on 2026-11-02 during the tests for item 2.

  Done (#5): the result was *intermittent* because `build()` waited a fixed `sleep(150)` and read the breadcrumb once, so it depended on how fast Drive rendered the header. Now there is a setting (`gdfPathMode` in `storage.sync`, on the extension's options page `options.html`): *Folder* (default) shows only the current folder when the page is loaded by URL; *Path* waits (`waitCrumbs`, 5 s timeout) for a stable breadcrumb, walks up through folders hidden behind "…" (`expandCrumbs`), loads the remaining folders (`preloadChain`, skipping the ones already loaded on the way up) and shows the whole path at once. Turning Columns on and navigating inside Drive still build the full path, as before.
  Tested: page reloads by URL in both modes (Folder and Path) at 4x CPU throttling; turning Columns on and navigating inside Drive builds the full path in Folder mode; Computers; abbreviated breadcrumb ("…"); folder opened from Shared with me (`rootId` stays unset); drag and drop.
- [ ] **Faster *Path* mode (idea):** it already opens each folder of the path only once, so what is left is Drive loading each one. Possible next step: cache the path and the ancestors' items per tab (`sessionStorage`) so reloading the same folder shows the full path at once and refreshes it in the background. Using the Drive API instead would need OAuth and new permissions.

## 6. Distribution

- [ ] Publish on the Chrome Web Store (possibly unlisted) to get automatic updates instead of reloading the folder by hand.
