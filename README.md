# Super Image Viewer

Super Image Viewer is a Tauri desktop app for browsing image folders as randomized or recent multi-image grids. It is designed for fast visual scanning, lightweight slideshows, and multiple window layouts.

## Features

- Display 4 to 99 images at once in a responsive grid.
- Random and recent display modes.
- Empty slots for visual spacing.
- Slideshow mode with configurable interval.
- Separate startup folder and slideshow options for the first and second app windows.
- Third and later windows intentionally start empty.
- Save separate first-window and secondary-window positions.
- Optional square Windows app corners.
- Optional startup UI autohide.

## Project Layout

- `src/index.html` - app markup and settings panel.
- `src/styles.css` - frontend styling.
- `src/renderer.js` - grid behavior, settings, slideshow, and window-role startup logic.
- `src/api.js` - Tauri JavaScript bridge.
- `src-tauri/src/lib.rs` - native commands, persisted settings, multi-window creation, and Windows corner handling.
- `src-tauri/tauri.conf.json` - Tauri app configuration.

## Development

Install dependencies:

```sh
npm install
```

Run in development:

```sh
npm run dev
```

Build the app:

```sh
npm run build
```

Useful checks:

```sh
node --check src/renderer.js
node --check src/api.js
cd src-tauri
cargo check
```

## Notes

Generated dependencies and build output are intentionally not committed. Recreate them with `npm install`, `npm run dev`, or `npm run build`.
