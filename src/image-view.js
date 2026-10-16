'use strict';

const img = document.getElementById('image');
const closeZone = document.getElementById('close-zone');
const btnClose = document.getElementById('btn-close');
const btnDrag = document.getElementById('btn-drag');
const contextMenu = document.getElementById('context-menu');
const menuFavorite = document.getElementById('menu-favorite');
const menuFavoriteLists = document.getElementById('menu-favorite-lists');
const menuCopy = document.getElementById('menu-copy');
const menuReveal = document.getElementById('menu-reveal');
const menuClose = document.getElementById('menu-close');
const statusEl = document.getElementById('status');

let currentPath = null;
let keepVisiblePinned = false;
let windowLabel = null;

// --- Zoom & pan state ---------------------------------------------------
// The <img> fills the window; we transform it (origin 0,0) to zoom/pan.
const MIN_SCALE = 0.1;
const MAX_SCALE = 20;
let scale = 1;
let panX = 0;
let panY = 0;

function applyTransform(animate = false) {
  if (animate) {
    img.style.transition = 'transform 0.3s ease-out';
    img.addEventListener('transitionend', () => {
      img.style.transition = '';
    }, { once: true });
  } else {
    img.style.transition = '';
  }
  img.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
}

function recenter() {
  scale = 1;
  panX = 0;
  panY = 0;
  applyTransform(true);
}

function zoomAt(clientX, clientY, factor) {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
  if (next === scale) return;
  // Keep the point under the cursor fixed: screen = pan + scale * boxPoint.
  panX = clientX - (clientX - panX) * (next / scale);
  panY = clientY - (clientY - panY) * (next / scale);
  scale = next;
  applyTransform();
}

const isZoomed = () => scale !== 1 || panX !== 0 || panY !== 0;

function showError(message) {
  document.body.classList.add('load-error');
  document.body.dataset.error = message;
  img.removeAttribute('src');
  img.alt = message;
}

async function init() {
  try {
    currentPath = await window.viewerAPI.getAssignedImagePath();
    if (!currentPath) {
      showError('Image path was not assigned.');
      return;
    }
    // CORS mode so the canvas used for copy-to-clipboard isn't tainted —
    // the asset: protocol is a different origin from the page itself.
    img.crossOrigin = 'anonymous';
    img.src = window.viewerAPI.getFileUrl(currentPath);
    await initFavorites();
  } catch (error) {
    console.error('Failed to load floating image:', error);
    showError('Failed to load image.');
  }
}

function closeWindow() {
  window.viewerAPI.windowClose().catch(() => window.close());
}

async function copyImageToClipboard() {
  if (!img.complete || !img.naturalWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return;
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

// --- Favorites ------------------------------------------------------------
// The same global store the grid's right-click menu writes (favorites.json, Rust side). This
// window only keeps its own image's slice of it: the declared lists, and the store entry for
// `currentPath` (null = not a favorite). Rust broadcasts every write, so a star set on the grid
// while this viewer is open shows up here, and one set here reaches the grid's tile badge.
let favoriteLists = [];
let favoriteEntry = null;
let statusTimer = null;

// Lowercased like the grid's fileKey and Rust's favorite_key — Windows paths are
// case-insensitive, and the same file reached two ways is ONE favorite.
const fileKey = (path) => String(path || '').toLocaleLowerCase();
const baseName = (path) => String(path || '').split(/[\\/]/).pop();

function installFavorites(view) {
  favoriteLists = Array.isArray(view && view.lists) ? view.lists.filter(Boolean) : [];
  const images = Array.isArray(view && view.images) ? view.images : [];
  const key = fileKey(currentPath);
  favoriteEntry = currentPath
    ? images.find(entry => entry && fileKey(entry.path) === key) || null
    : null;
  document.body.classList.toggle('favorited', !!favoriteEntry);
  if (contextMenu.classList.contains('open')) renderFavoriteMenu();
}

async function loadFavorites() {
  try {
    installFavorites(await window.viewerAPI.loadFavorites());
  } catch (error) {
    console.error('Failed to load favorites:', error);
  }
}

function showStatus(message) {
  clearTimeout(statusTimer);
  // Cleared first so the same message twice in a row is still announced.
  statusEl.textContent = '';
  statusEl.textContent = message;
  statusEl.classList.add('visible');
  statusTimer = setTimeout(() => statusEl.classList.remove('visible'), 1600);
}

async function applyFavoriteChange(run, message) {
  try {
    installFavorites(await run());
  } catch (error) {
    console.error('Favorites write failed:', error);
    // A Tauri command rejects with a plain string, not an Error.
    showStatus(typeof error === 'string' && error ? error : 'Could not save favorites');
    await loadFavorites();
    return;
  }
  showStatus(message);
}

// A toggle, exactly like the grid menu's lead item: the same click undoes a mis-aimed one.
function toggleFavorite() {
  if (!currentPath) return;
  const nowFavorite = !favoriteEntry;
  const listed = favoriteEntry ? favoriteEntry.lists || [] : [];
  applyFavoriteChange(
    () => window.viewerAPI.setFavorite(currentPath, nowFavorite),
    nowFavorite
      ? 'Favorited'
      : (listed.length ? `Removed from favorites (was in ${listed.join(', ')})` : 'Removed from favorites'),
  );
}

function setFavoriteListMembership(list, member) {
  if (!currentPath) return;
  applyFavoriteChange(
    () => window.viewerAPI.setFavoriteList(currentPath, list, member),
    member ? `Added to ${list}` : `Removed from ${list}`,
  );
}

// Rebuilt on every open. Lists appear only when some exist — with none defined the menu carries
// the one Favorite item, same as the grid's. Creating a list stays in the main window's panel.
function renderFavoriteMenu() {
  const name = baseName(currentPath);
  const favorited = !!favoriteEntry;
  menuFavorite.textContent = favorited ? '★ Favorited' : '☆ Favorite';
  menuFavorite.classList.toggle('current', favorited);
  menuFavorite.setAttribute('aria-pressed', String(favorited));
  menuFavorite.setAttribute('aria-label', favorited
    ? `Remove ${name} from favorites`
    : `Favorite ${name}`);

  menuFavoriteLists.textContent = '';
  if (!favoriteLists.length) return;
  const held = new Set(favoriteEntry ? favoriteEntry.lists || [] : []);
  const title = document.createElement('div');
  title.className = 'menu-title';
  title.textContent = 'Favorite lists';
  menuFavoriteLists.append(title);
  for (const list of favoriteLists) {
    const inList = held.has(list);
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(inList));
    button.setAttribute('aria-label', inList ? `Remove ${name} from ${list}` : `Add ${name} to ${list}`);
    const label = document.createElement('span');
    label.textContent = list;
    const mark = document.createElement('span');
    mark.textContent = inList ? '✓' : '';
    button.append(label, mark);
    button.addEventListener('click', () => {
      closeContextMenu();
      setFavoriteListMembership(list, !inList);
    });
    menuFavoriteLists.append(button);
  }
}

async function initFavorites() {
  windowLabel = await window.viewerAPI.getWindowLabel().catch(() => null);
  // Listen BEFORE the first load, so a write landing in between is not missed. This window's own
  // writes are skipped: their return value is already installed, and a late echo could only roll
  // a newer edit back.
  await window.viewerAPI.onFavoritesChanged((payload) => {
    if (!payload || payload.source === windowLabel) return;
    installFavorites(payload);
  }).catch(error => console.error('Failed to listen for favorites changes:', error));
  await loadFavorites();
}

function openContextMenu(x, y) {
  contextMenu.classList.add('open');
  const maxX = window.innerWidth - contextMenu.offsetWidth - 4;
  const maxY = window.innerHeight - contextMenu.offsetHeight - 4;
  contextMenu.style.left = `${Math.max(4, Math.min(x, maxX))}px`;
  contextMenu.style.top = `${Math.max(4, Math.min(y, maxY))}px`;
}

function closeContextMenu() {
  contextMenu.classList.remove('open');
}

function isInteractiveTarget(target) {
  return closeZone.contains(target) || contextMenu.contains(target);
}

// Outer band (≈ a window title bar's thickness) drags the OS window; the
// inner area pans the zoomed image.
const EDGE_THICKNESS = 32;

function isEdgeZone(clientX, clientY) {
  return clientX <= EDGE_THICKNESS ||
    clientY <= EDGE_THICKNESS ||
    clientX >= window.innerWidth - EDGE_THICKNESS ||
    clientY >= window.innerHeight - EDGE_THICKNESS;
}

let panPointerId = null;
let panStartX = 0;
let panStartY = 0;
let panOriginX = 0;
let panOriginY = 0;

function startWindowDrag(e) {
  if (e.button !== 0 || e.detail > 1 || isInteractiveTarget(e.target)) return;
  closeContextMenu();
  // The edge band always moves the window, regardless of zoom.
  if (isEdgeZone(e.clientX, e.clientY)) {
    window.viewerAPI.windowStartDrag().catch(console.error);
    return;
  }
  // The center pans the image when zoomed in.
  if (isZoomed()) {
    panPointerId = e.pointerId;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panOriginX = panX;
    panOriginY = panY;
    img.setPointerCapture(panPointerId);
    img.style.cursor = 'grabbing';
    e.preventDefault();
  }
}

img.addEventListener('pointermove', (e) => {
  if (panPointerId === null || e.pointerId !== panPointerId) return;
  panX = panOriginX + (e.clientX - panStartX);
  panY = panOriginY + (e.clientY - panStartY);
  applyTransform();
});

function endPan(e) {
  if (panPointerId === null || e.pointerId !== panPointerId) return;
  try { img.releasePointerCapture(panPointerId); } catch { /* ignore */ }
  panPointerId = null;
  img.style.cursor = '';
}

// Cursor hint: move over the edge band, grab over the pannable center.
document.addEventListener('pointermove', (e) => {
  if (panPointerId !== null) return;
  if (isInteractiveTarget(e.target)) {
    img.style.cursor = '';
  } else if (isEdgeZone(e.clientX, e.clientY)) {
    img.style.cursor = 'move';
  } else {
    img.style.cursor = isZoomed() ? 'grab' : '';
  }
});
img.addEventListener('pointerup', endPan);
img.addEventListener('pointercancel', endPan);

img.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });

btnClose.addEventListener('click', closeWindow);
btnDrag.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  closeContextMenu();
  e.preventDefault();
  // Keep the controls pinned during the native drag (which can drop :hover
  // and fire a spurious pointerleave) and afterwards until the pointer
  // actually moves away from the zone.
  keepVisiblePinned = true;
  closeZone.classList.add('keep-visible');
  window.viewerAPI.windowStartDrag().catch(console.error);
});

// Un-pin only once the cursor has genuinely left the zone's vicinity.
document.addEventListener('mousemove', (e) => {
  if (!keepVisiblePinned) return;
  // Ignore events fired while a button is held — i.e. during the native
  // drag loop, where the cursor can report stray coordinates.
  if (e.buttons !== 0) return;
  const r = closeZone.getBoundingClientRect();
  const margin = 12;
  const outside =
    e.clientX < r.left - margin || e.clientX > r.right + margin ||
    e.clientY < r.top - margin || e.clientY > r.bottom + margin;
  if (outside) {
    keepVisiblePinned = false;
    closeZone.classList.remove('keep-visible');
  }
});
img.addEventListener('dblclick', closeWindow);
document.addEventListener('pointerdown', startWindowDrag);

// Suppress the native webview menu (removes "More tools" / "Inspect"); the
// image gets a custom menu instead, other areas just get nothing.
document.addEventListener('contextmenu', (e) => e.preventDefault());

img.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // Before opening: openContextMenu clamps by the menu's size, which the list rows change.
  renderFavoriteMenu();
  openContextMenu(e.clientX, e.clientY);
});

document.addEventListener('click', (e) => {
  if (!contextMenu.contains(e.target)) closeContextMenu();
});

menuFavorite.addEventListener('click', () => {
  closeContextMenu();
  toggleFavorite();
});

menuCopy.addEventListener('click', () => {
  closeContextMenu();
  copyImageToClipboard();
});

menuReveal.addEventListener('click', () => {
  closeContextMenu();
  if (currentPath) window.viewerAPI.revealInFolder(currentPath).catch(console.error);
});

menuClose.addEventListener('click', () => {
  closeContextMenu();
  closeWindow();
});

document.addEventListener('keydown', (e) => {
  // Escape backs out one layer at a time: menu first, then the window.
  // Delete is deliberately unbound — every other image viewer deletes the
  // file with it, so closing on Delete reads as data loss that didn't happen.
  if (e.key === 'Escape') {
    if (contextMenu.classList.contains('open')) {
      closeContextMenu();
      return;
    }
    e.preventDefault();
    closeWindow();
    return;
  }
  // F favorites, as it does for the hovered tile on the grid.
  if ((e.key === 'f' || e.key === 'F') && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    toggleFavorite();
    return;
  }
  if (e.key === 'c' || e.key === 'C') {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      copyImageToClipboard();
    } else {
      recenter();
    }
  }
});

init();
