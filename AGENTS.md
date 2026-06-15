# Agent Notes

This repository is intentionally small. Keep it that way.

## Do Not Commit

- `node_modules/`
- `src-tauri/target/`
- generated installer binaries
- local `.env*` files
- app runtime settings or cache files
- generated Tauri schema files under `src-tauri/gen/schemas/`

## Architecture

The frontend is plain HTML/CSS/JavaScript. There is no bundler step for `src`; Tauri serves the files directly from `src`.

Native behavior lives in `src-tauri/src/lib.rs`. Settings are serialized with camelCase names and saved in the platform app data directory. Keep setting migrations backward compatible when renaming fields.

Window labels matter:

- `main` is the first window.
- `viewer-1` is the second window.
- `viewer-2` and later are third-plus windows.

Startup folders and auto-slideshow apply only to the first and second windows. Third-plus windows should open empty.

## Checks

Before publishing changes, run:

```sh
node --check src/renderer.js
node --check src/api.js
cd src-tauri
cargo check
```
