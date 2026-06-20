'use strict';

// ==============================
// Constants
// ==============================
const HISTORY_MAX   = 50;
const COUNT_PRESETS = [4, 6, 8, 9, 12, 16, 20, 25, 32, 40, 49, 64, 81, 99];
const ZOOM_BIAS_REPEAT_MS = 1000 / 24;
const ZOOM_BIAS_HOLD_DELAY_MS = 180;
const ZOOM_BIAS_STEP_SCALE = 0.25;
const ZOOM_FILL_COVER_AT = 50;
const ZOOM_FILL_SNAP_RADIUS = 3;
const ZOOM_FILL_PRESETS = { fill: ZOOM_FILL_COVER_AT, 1: 25, 2: 58, 3: 75 };
const ZOOM_FILL_PARTIAL_MAX_SCALE = 1.12;
const ZOOM_FILL_MAX_SCALE = 1.32;
const MANUAL_ZOOM_MAX = 4;
const MANUAL_DRAG_THRESHOLD_PX = 4;
const MANUAL_WHEEL_ZOOM_FACTOR = 0.0015;
const SLIDESHOW_PRELOAD_LEAD_MS = 1200;
const SLIDESHOW_STAGGER_BATCH_SIZE = 6;
const SLIDESHOW_STAGGER_DELAY_MS = 28;
const PORTRAIT_AUTO_BIAS_MIN_ASPECT = 1.02;
const PORTRAIT_FILL_MAX_EXTRA_SCALE = 1.08;
const PORTRAIT_FACE_SAFE_PAN = 0.78;
const PORTRAIT_BIAS_STEP_CELL_RATIO = 0.0015;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ==============================
// State
// ==============================
const state = {
  folder:     null,
  allImages:  [],          // [{path, modified}] newest-first
  browseMode: 'multi',    // 'multi' | 'categorized'
  viewedBrowseMode: 'multi',
  multiFolders: [],
  multiFolderFilter: new Set(),
  categorizedRoot: null,
  categorizedCategories: [],
  categorizedCategoryFilter: new Set(),
  categorizedImages: [],

  imageCount: 9,
  emptyCount: 0,
  displayMode: 'random',  // 'random' | 'chrono'
  chronoOffset: 0,        // index into allImages for chrono mode

  displayedSlots: [],     // (string|null)[] — null = intentional empty slot

  slideshow:         false,
  slideshowDuration: 5000,
  slideshowTimer:    null,
  slideshowPreloadTimer: null,
  slideshowPreload: null,
  slideshowPreloadToken: 0,
  gridRenderToken: 0,

  uiHidden:     false,
  settingsOpen: false,
};

// Per-image manual pan/zoom override (grid only) — keyed by <img> so it's
// automatically dropped once that element is discarded (new image in slot).
const imageManualZoom = new WeakMap(); // img -> { scale, tx, ty }
let hoveredCell = null;
let lastManualZoomCell = null;
let manualZoomActiveCount = 0;

function setImageManualZoom(img, value) {
  img.style.transition = '';
  if (!imageManualZoom.has(img)) manualZoomActiveCount++;
  imageManualZoom.set(img, value);
}

function deleteImageManualZoom(img) {
  if (imageManualZoom.delete(img)) {
    manualZoomActiveCount = Math.max(0, manualZoomActiveCount - 1);
  }
}

function clearImageManualZoom(img, animate = false) {
  const cell = img.closest('.grid-cell');

  if (animate && imageManualZoom.has(img)) {
    const resetManual = { scale: 1, tx: 0, ty: 0, resetting: true };
    let finished = false;
    const finish = () => {
      if (finished) return;
      if (imageManualZoom.get(img) !== resetManual) return;
      finished = true;
      img.style.transition = '';
      deleteImageManualZoom(img);
      if (cell === lastManualZoomCell) lastManualZoomCell = null;
      cell?.classList.remove('manual-zoom');
      img.style.objectFit = '';
      img.style.transform = '';
      applyZoomFillToImages();
    };

    img.style.transition = 'transform 0.3s ease-out';
    img.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 360);
    imageManualZoom.set(img, resetManual);
    return;
  }

  deleteImageManualZoom(img);
  if (cell === lastManualZoomCell) lastManualZoomCell = null;
  cell?.classList.remove('manual-zoom');
  img.style.objectFit = '';
  img.style.transform = '';
}

// Session history — array of {slots, chronoOffset}
const hist = { stack: [], pos: -1 };

// Blocks persistSettings() during the startup load
let startupDone = false;
let windowLabel = 'main';
let zoomBiasRepeatTimer = null;
let zoomBiasHoldTimer = null;
let zoomBiasRepeatPointerId = null;
const appSettings = {
  squareAppCorners: false,
  zoomFillEnabled: true,
  zoomFillLevel: 2,
  zoomFillAmount: ZOOM_FILL_PRESETS.fill,
  zoomFillVersion: 6,
  zoomFillBiasDirection: '',
  zoomFillBiasAmount: 0,
  firstAutoOpenSlideshow: false,
  secondaryAutoOpenSlideshow: false,
  autoSlideshowSource: 'folders',
  autoHideUiOnStartup: false,
  instantFilterCategorized: true,
  startupBrowseMode: 'multi',
  startupMultiFolders: [],
  startupMultiFolderFilter: [],
  startupCategorizedRoot: null,
  startupCategorizedCategoryFilter: [],
};

// ==============================
// DOM references
// ==============================
const imageGrid          = document.getElementById('image-grid');
const folderNameEl       = document.getElementById('folder-name');
const folderButtonLabel  = document.getElementById('folder-button-label');
const folderPanel        = document.getElementById('folder-panel');
const folderModeTabs     = document.querySelectorAll('.folder-mode-tab');
const folderLoading      = document.getElementById('folder-loading');
const folderLoadingText  = document.getElementById('folder-loading-text');
const folderSectionMulti = document.getElementById('folder-section-multi');
const folderSectionCategorized = document.getElementById('folder-section-categorized');
const folderMultiAdd     = document.getElementById('folder-multi-add');
const multiFolderListEl  = document.getElementById('multi-folder-list');
const categorizedRootNameEl = document.getElementById('categorized-root-name');
const categorizedRootChoose = document.getElementById('categorized-root-choose');
const categoriesList     = document.getElementById('categories-list');
const categoriesSelectAll = document.getElementById('categories-select-all');
const categoriesSelectNone = document.getElementById('categories-select-none');
const categoriesRescan   = document.getElementById('categories-rescan');
const countDisplayEl     = document.getElementById('count-display');
const emptyDisplayEl     = document.getElementById('empty-display');
const btnFolder          = document.getElementById('btn-folder');
const btnOpenEmpty       = document.getElementById('btn-open-empty');
const btnCountDec        = document.getElementById('btn-count-dec');
const btnCountInc        = document.getElementById('btn-count-inc');
const btnEmptyDec        = document.getElementById('btn-empty-dec');
const btnEmptyInc        = document.getElementById('btn-empty-inc');
const btnModeRandom      = document.getElementById('btn-mode-random');
const btnModeChrono      = document.getElementById('btn-mode-chrono');
const btnZoomFill        = document.getElementById('btn-zoom-fill');
const btnZoomLevel1      = document.getElementById('btn-zoom-level-1');
const btnZoomLevel2      = document.getElementById('btn-zoom-level-2');
const btnZoomLevel3      = document.getElementById('btn-zoom-level-3');
const zoomFillSlider     = document.getElementById('zoom-fill-slider');
const zoomBiasControl    = document.getElementById('zoom-bias-control');
const zoomBiasLetter     = document.getElementById('zoom-bias-letter');
const zoomBiasValue      = document.getElementById('zoom-bias-value');
const btnSlideshow       = document.getElementById('btn-slideshow');
const btnShuffle         = document.getElementById('btn-shuffle');
const btnRefresh         = document.getElementById('btn-refresh');
const btnNavPrev         = document.getElementById('btn-nav-prev');
const btnNavNext         = document.getElementById('btn-nav-next');
const btnSettings        = document.getElementById('btn-settings');
const settingsPanel      = document.getElementById('settings-panel');
const settingSaveFirstWindow       = document.getElementById('setting-save-first-window');
const settingResetFirstWindow      = document.getElementById('setting-reset-first-window');
const settingSaveSecondaryWindow   = document.getElementById('setting-save-secondary-window');
const settingResetSecondaryWindow  = document.getElementById('setting-reset-secondary-window');
const settingSquareAppCorners      = document.getElementById('setting-square-app-corners');
const settingAutoHideUi            = document.getElementById('setting-auto-hide-ui');
const settingInstantFilter         = document.getElementById('setting-instant-filter');
const settingFirstAutoOpenSlideshow = document.getElementById('setting-first-auto-open-slideshow');
const settingSecondaryAutoOpenSlideshow = document.getElementById('setting-secondary-auto-open-slideshow');
const settingAutoSlideshowSource   = document.getElementById('setting-auto-slideshow-source');
const settingAutoSlideshowFolderNeeded = document.getElementById('setting-auto-slideshow-folder-needed');
const settingSlider      = document.getElementById('setting-count-slider');
const settingCountVal    = document.getElementById('setting-count-value');
const settingStartupBrowseMode = document.getElementById('setting-startup-browse-mode');
const settingUseCurrentSource = document.getElementById('setting-use-current-source');
const settingStartupSourceName = document.getElementById('setting-startup-source-name');
const settingSlideshowDur = document.getElementById('setting-slideshow-duration');
const btnMinimize        = document.getElementById('btn-minimize');
const btnClose           = document.getElementById('btn-close');
const gridContextMenu    = document.getElementById('grid-context-menu');

// ==============================
// Grid layout
// ==============================
function applyGridLayout(count) {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  imageGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  imageGrid.style.gridTemplateRows    = `repeat(${rows}, 1fr)`;
}

// ==============================
// Image selection
// ==============================
function pickRandom(n) {
  if (!state.allImages.length) return [];
  const pool   = state.allImages.slice();
  const result = [];
  while (result.length < n && pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    result.push(pool.splice(idx, 1)[0].path);
  }
  return result;
}

function pickChrono(n, offset) {
  return state.allImages
    .slice(Math.max(0, offset), offset + n)
    .map(img => img.path);
}

// Build a slot array: image paths + null empty slots, all shuffled together
function generateSlots(chronoOffset = state.chronoOffset) {
  const total   = state.imageCount;
  const empties = Math.min(state.emptyCount, total - 1);
  const imgN    = total - empties;

  const paths = state.displayMode === 'random'
    ? pickRandom(imgN)
    : pickChrono(imgN, chronoOffset);

  // Pad with nulls if fewer images than requested (e.g. small folder)
  const imagePart = [
    ...paths,
    ...Array(Math.max(0, imgN - paths.length)).fill(null),
  ];
  const slots = [...imagePart, ...Array(empties).fill(null)];

  // Fisher-Yates shuffle
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  return slots;
}

// ==============================
// History
// ==============================
function pushHistory(slots, chronoOffset) {
  hist.stack.splice(hist.pos + 1);                 // discard forward entries
  hist.stack.push({ slots: [...slots], chronoOffset });
  if (hist.stack.length > HISTORY_MAX) hist.stack.shift();
  hist.pos = hist.stack.length - 1;
  syncNavButtons();
}

function restoreEntry(entry, options = {}) {
  state.displayedSlots = [...entry.slots];
  state.chronoOffset   = entry.chronoOffset;
  renderGrid(state.displayedSlots, options);
}

function syncNavButtons() {
  btnNavPrev.disabled = hist.pos <= 0;
}

function startupSourceLabel() {
  if (appSettings.startupBrowseMode === 'multi') {
    const folders = appSettings.startupMultiFolders || [];
    const enabled = new Set(appSettings.startupMultiFolderFilter || []);
    const enabledCount = folders.filter(folder => enabled.has(fileKey(folder))).length || folders.length;
    return folders.length ? `${enabledCount}/${folders.length} folders` : 'No multi-folders set';
  }
  return appSettings.startupCategorizedRoot
    ? baseName(appSettings.startupCategorizedRoot)
    : 'No categorized root set';
}

function syncStartupSourceSettings() {
  settingStartupBrowseMode.value = appSettings.startupBrowseMode;
  settingStartupSourceName.textContent = startupSourceLabel();
  settingStartupSourceName.title = startupSourceLabel();
  syncAutoSlideshowSourceSettings();
}

function isSecondWindow() {
  return windowLabel === 'viewer-1';
}

function shouldAutoStartSlideshow() {
  if (windowLabel === 'main') {
    return appSettings.firstAutoOpenSlideshow;
  }
  return isSecondWindow() && appSettings.secondaryAutoOpenSlideshow;
}

function hasStartupFolders() {
  return !!(appSettings.startupMultiFolders && appSettings.startupMultiFolders.length);
}

function shouldShowAutoSlideshowFolderPrompt() {
  const autoStartEnabled = appSettings.firstAutoOpenSlideshow || appSettings.secondaryAutoOpenSlideshow;
  return autoStartEnabled && appSettings.autoSlideshowSource === 'folders' && !hasStartupFolders();
}

function syncAutoSlideshowSourceSettings() {
  settingAutoSlideshowSource.value = appSettings.autoSlideshowSource;
  settingAutoSlideshowFolderNeeded.hidden = !shouldShowAutoSlideshowFolderPrompt();
}

async function loadAutoSlideshowCategorizedSource() {
  const root = appSettings.startupCategorizedRoot || state.categorizedRoot;
  if (appSettings.startupCategorizedRoot) {
    state.categorizedRoot = appSettings.startupCategorizedRoot;
    state.categorizedCategoryFilter = new Set(appSettings.startupCategorizedCategoryFilter);
  }
  state.viewedBrowseMode = 'categorized';
  renderCategorizedRootRow();
  renderFolderPanelSections();
  await enterCategorizedMode(root);
  if (state.browseMode !== 'categorized') {
    loadImagePool([], root ? baseName(root) : 'No categorized root', 'categorized');
  }
}

function hasConfiguredStartupSource() {
  if (appSettings.startupBrowseMode === 'multi') return !!appSettings.startupMultiFolders.length;
  return !!appSettings.startupCategorizedRoot;
}

async function loadConfiguredStartupSource() {
  if (appSettings.startupBrowseMode === 'multi') {
    state.multiFolders = [...appSettings.startupMultiFolders];
    state.multiFolderFilter = new Set(appSettings.startupMultiFolderFilter);
    normalizeMultiFolderFilter({ defaultAll: true });
    renderMultiFolderList();
    state.viewedBrowseMode = 'multi';
    renderFolderPanelSections();
    await enterMultiMode();
    return;
  }

  state.categorizedRoot = appSettings.startupCategorizedRoot;
  state.categorizedCategoryFilter = new Set(appSettings.startupCategorizedCategoryFilter);
  state.viewedBrowseMode = 'categorized';
  renderCategorizedRootRow();
  renderFolderPanelSections();
  await enterCategorizedMode();
}

async function loadAutoSlideshowSource() {
  if (appSettings.autoSlideshowSource === 'categorized') {
    await loadAutoSlideshowCategorizedSource();
    return;
  }

  state.multiFolders = [...appSettings.startupMultiFolders];
  state.multiFolderFilter = new Set(appSettings.startupMultiFolderFilter);
  normalizeMultiFolderFilter({ defaultAll: true });
  renderMultiFolderList();
  state.viewedBrowseMode = 'multi';
  renderFolderPanelSections();
  await enterMultiMode();
}

// ==============================
// Render grid
// ==============================
function applyImageSlot(img, slot) {
  if (img.getAttribute('data-src') === slot) return;
  clearImageManualZoom(img);
  img.setAttribute('data-src', slot);
  img.removeAttribute('data-pending-src');
  img.classList.remove('loaded');
  img.onload  = () => {
    img.classList.add('loaded');
    applyZoomFillToImages();
  };
  img.onerror = () => {};
  img.src = window.viewerAPI.getFileUrl(slot);
}

function renderGrid(slots, options = {}) {
  const stagger = !!options.stagger;
  const renderToken = ++state.gridRenderToken;
  applyGridLayout(slots.length || state.imageCount);

  const existing = [...imageGrid.querySelectorAll('.grid-cell')];
  const pendingImageUpdates = [];

  // Remove excess cells
  for (let i = slots.length; i < existing.length; i++) {
    const img = existing[i].querySelector('img');
    if (img) clearImageManualZoom(img);
    existing[i].remove();
  }

  slots.forEach((slot, i) => {
    let cell = i < existing.length ? existing[i] : (() => {
      const c = document.createElement('div');
      c.className = 'grid-cell';
      imageGrid.appendChild(c);
      attachCellInteractions(c);
      return c;
    })();

    if (slot === null) {
      cell.classList.add('empty-slot');
      const img = cell.querySelector('img');
      if (img) {
        clearImageManualZoom(img);
        img.remove();
      }
    } else {
      cell.classList.remove('empty-slot');
      let img = cell.querySelector('img');
      if (!img) {
        img = document.createElement('img');
        img.draggable = false;
        cell.appendChild(img);
      }
      if (img.getAttribute('data-src') !== slot) {
        if (stagger) {
          img.setAttribute('data-pending-src', slot);
          pendingImageUpdates.push({ img, slot });
        }
        else applyImageSlot(img, slot);
      } else {
        img.removeAttribute('data-pending-src');
      }
    }
  });
  applyZoomFillToImages();

  if (!pendingImageUpdates.length) return;

  pendingImageUpdates.forEach((update, index) => {
    const batch = Math.floor(index / SLIDESHOW_STAGGER_BATCH_SIZE);
    window.setTimeout(() => {
      if (renderToken !== state.gridRenderToken) return;
      applyImageSlot(update.img, update.slot);
    }, batch * SLIDESHOW_STAGGER_DELAY_MS);
  });
}

// Wires per-cell drag-to-pan / wheel-to-zoom / click-to-open-floating-view.
// Attached once per .grid-cell element (cells are reused across renders), so
// it always looks up the current <img> inside the cell at interaction time.
function attachCellInteractions(cell) {
  let drag = null;

  cell.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    // A left-click while the categorize menu is open just dismisses it —
    // don't start a drag or open the floating image on that same click.
    if (gridContextMenu.classList.contains('open')) {
      closeGridContextMenu();
      return;
    }
    const img = cell.querySelector('img');
    if (!img || !img.naturalWidth) return;
    drag = {
      pointerId: e.pointerId,
      img,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      baseline: imageManualZoom.get(img) || { scale: 1, tx: 0, ty: 0 },
    };
    try { cell.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });

  cell.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.dragging) {
      if (Math.hypot(dx, dy) < MANUAL_DRAG_THRESHOLD_PX) return;
      drag.dragging = true;
      lastManualZoomCell = cell;
      cell.classList.add('panning');
    }

    const rect = cell.getBoundingClientRect();
    const totalScale = zoomFillScale(appSettings.zoomFillAmount) * drag.baseline.scale;
    const { maxTx, maxTy } = manualZoomOverflow(drag.img, rect, totalScale);
    setImageManualZoom(drag.img, {
      scale: drag.baseline.scale,
      tx: clamp(drag.baseline.tx + dx, -maxTx, maxTx),
      ty: clamp(drag.baseline.ty + dy, -maxTy, maxTy),
    });
    applyZoomFillToImages();
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const wasDragging = drag.dragging;
    try { cell.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    cell.classList.remove('panning');
    drag = null;
    if (!wasDragging) openFloatingImage(cell);
  }
  cell.addEventListener('pointerup', endDrag);
  cell.addEventListener('pointercancel', () => {
    cell.classList.remove('panning');
    drag = null;
  });

  cell.addEventListener('wheel', e => {
    const img = cell.querySelector('img');
    if (!img || !img.naturalWidth) return;
    e.preventDefault();
    const current = imageManualZoom.get(img) || { scale: 1, tx: 0, ty: 0 };
    const nextScale = clamp(current.scale * Math.exp(-e.deltaY * MANUAL_WHEEL_ZOOM_FACTOR), 1, MANUAL_ZOOM_MAX);
    const rect = cell.getBoundingClientRect();
    const scaleRatio = nextScale / current.scale;
    const pointerX = e.clientX - rect.left - rect.width / 2;
    const pointerY = e.clientY - rect.top - rect.height / 2;
    const totalScale = zoomFillScale(appSettings.zoomFillAmount) * nextScale;
    const { maxTx, maxTy } = manualZoomOverflow(img, rect, totalScale);
    setImageManualZoom(img, {
      scale: nextScale,
      tx: clamp(pointerX - (pointerX - current.tx) * scaleRatio, -maxTx, maxTx),
      ty: clamp(pointerY - (pointerY - current.ty) * scaleRatio, -maxTy, maxTy),
    });
    lastManualZoomCell = cell;
    applyZoomFillToImages();
  }, { passive: false });

  cell.addEventListener('pointerenter', () => { hoveredCell = cell; });
  cell.addEventListener('pointerleave', () => {
    if (hoveredCell === cell) hoveredCell = null;
  });
}

function openFloatingImage(cell) {
  const img = cell.querySelector('img');
  if (!img || !img.naturalWidth) return;
  if (img.hasAttribute('data-pending-src')) return;
  const path = img.getAttribute('data-src');
  if (!path) return;
  const rect = cell.getBoundingClientRect();
  window.viewerAPI
    .openImageWindow(path, rect, img.naturalWidth, img.naturalHeight)
    .catch(error => {
      console.error('Failed to open image window:', error);
      showToast('Failed to open image');
    });
}

// ==============================
// Slideshow preloading
// ==============================
function nextChronoOffset() {
  if (state.displayMode !== 'chrono') return state.chronoOffset;
  const step = Math.max(1, state.imageCount - state.emptyCount);
  return Math.min(state.allImages.length - 1, state.chronoOffset + step);
}

function buildNextSlideshowPlan() {
  if (hist.pos < hist.stack.length - 1) {
    const entry = hist.stack[hist.pos + 1];
    return {
      slots: [...entry.slots],
      chronoOffset: entry.chronoOffset,
      fromHistory: true,
    };
  }

  const chronoOffset = nextChronoOffset();
  return {
    slots: generateSlots(chronoOffset),
    chronoOffset,
    fromHistory: false,
  };
}

function preloadImage(path, keepAlive) {
  return new Promise(resolve => {
    if (!path) {
      resolve();
      return;
    }

    const img = new Image();
    keepAlive.push(img);
    img.decoding = 'async';
    img.loading = 'eager';
    let doneCalled = false;

    const done = () => {
      if (doneCalled) return;
      doneCalled = true;
      if (typeof img.decode === 'function') {
        img.decode().catch(() => {}).finally(resolve);
      } else {
        resolve();
      }
    };

    img.onload = done;
    img.onerror = resolve;
    img.src = window.viewerAPI.getFileUrl(path);
    if (img.complete) done();
  });
}

function clearSlideshowPreload() {
  clearTimeout(state.slideshowPreloadTimer);
  state.slideshowPreloadTimer = null;
  state.slideshowPreload = null;
  state.slideshowPreloadToken++;
}

function startSlideshowPreload() {
  if (!state.slideshow || document.hidden || !state.allImages.length) return;

  const token = ++state.slideshowPreloadToken;
  const plan = buildNextSlideshowPlan();
  const keepAlive = [];
  const paths = [...new Set(plan.slots.filter(Boolean))];

  const preload = {
    ...plan,
    token,
    keepAlive,
    ready: false,
  };
  state.slideshowPreload = preload;

  Promise
    .all(paths.map(path => preloadImage(path, keepAlive)))
    .then(() => {
      if (state.slideshowPreload !== preload || state.slideshowPreloadToken !== token) return;
      preload.ready = true;
    });
}

function scheduleSlideshowPreload() {
  clearTimeout(state.slideshowPreloadTimer);
  state.slideshowPreloadTimer = null;
  if (!state.slideshow || document.hidden || !state.allImages.length) return;

  const delay = Math.max(0, state.slideshowDuration - SLIDESHOW_PRELOAD_LEAD_MS);
  state.slideshowPreloadTimer = setTimeout(startSlideshowPreload, delay);
}

function takeSlideshowPreloadPlan() {
  const preload = state.slideshowPreload;
  if (!preload || !preload.ready) return null;
  state.slideshowPreload = null;
  return preload;
}

// ==============================
// Refresh — generate a new set
// ==============================
function refresh(options = {}) {
  if (!state.allImages.length) return;
  const slots = generateSlots();
  state.displayedSlots = slots;
  renderGrid(slots, options);
  pushHistory(slots, state.chronoOffset);
  rescheduleSlideshowTick();
}

// ==============================
// Navigation (← →)
// ==============================
function navigateBack() {
  if (hist.pos <= 0) return;
  hist.pos--;
  restoreEntry(hist.stack[hist.pos], { stagger: state.slideshow });
  syncNavButtons();
  rescheduleSlideshowTick();
}

function navigateForward() {
  if (hist.pos < hist.stack.length - 1) {
    // Re-play a set from history
    hist.pos++;
    restoreEntry(hist.stack[hist.pos], { stagger: state.slideshow });
    syncNavButtons();
  } else {
    const preloadedPlan = state.slideshow ? takeSlideshowPreloadPlan() : null;
    if (preloadedPlan) {
      state.chronoOffset = preloadedPlan.chronoOffset;
      state.displayedSlots = [...preloadedPlan.slots];
      renderGrid(state.displayedSlots, { stagger: true });
      pushHistory(state.displayedSlots, state.chronoOffset);
      rescheduleSlideshowTick();
      return;
    }

    // At the head — generate a new set
    if (state.displayMode === 'chrono') {
      state.chronoOffset = nextChronoOffset();
    }
    refresh({ stagger: state.slideshow });
  }
  rescheduleSlideshowTick();
}

// ==============================
// Shuffle current set
// ==============================
function shuffleCurrent() {
  if (!state.displayedSlots.length) return;
  const slots = [...state.displayedSlots];
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  state.displayedSlots = slots;
  renderGrid(slots);
  pushHistory(slots, state.chronoOffset); // shuffled order becomes a new history entry
}

// ==============================
// Slideshow
// ==============================
function syncSlideshowButton() {
  btnSlideshow.classList.toggle('active', state.slideshow);
  document.body.classList.toggle('slideshow-active', state.slideshow);
  btnSlideshow.textContent = state.slideshow ? 'ON' : '\u23F5';
  btnSlideshow.title = state.slideshow
    ? 'Slideshow is on - click to stop'
    : 'Slideshow - auto-advance sets';
}

function startSlideshow() {
  if (!state.allImages.length) return;
  state.slideshow = true;
  syncSlideshowButton();
  rescheduleSlideshowTick();
}

function stopSlideshow() {
  state.slideshow = false;
  syncSlideshowButton();
  clearTimeout(state.slideshowTimer);
  state.slideshowTimer = null;
  clearSlideshowPreload();
}

function toggleSlideshow() {
  if (state.slideshow) stopSlideshow();
  else startSlideshow();
}

function rescheduleSlideshowTick() {
  clearTimeout(state.slideshowTimer);
  clearSlideshowPreload();
  if (!state.slideshow) return;
  state.slideshowTimer = setTimeout(() => {
    if (!state.slideshow) return;
    navigateForward();
  }, state.slideshowDuration);
  scheduleSlideshowPreload();
}

document.addEventListener('visibilitychange', () => {
  if (!state.slideshow) return;
  if (document.hidden) {
    clearTimeout(state.slideshowTimer);
    state.slideshowTimer = null;
    clearSlideshowPreload();
  } else {
    rescheduleSlideshowTick();
  }
});

// ==============================
// Folder loading
// ==============================
function clearDisplayFolder() {
  state.gridRenderToken++;
  clearSlideshowPreload();
  hoveredCell = null;
  lastManualZoomCell = null;
  state.folder = null;
  state.allImages = [];
  state.displayedSlots = [];
  state.chronoOffset = 0;
  hist.stack = [];
  hist.pos = -1;
  imageGrid.textContent = '';
  folderNameEl.textContent = '';
  document.body.classList.add('no-folder');
  renderFolderButton();
  stopSlideshow();
  syncNavButtons();
}

function baseName(path) {
  return String(path || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Folder';
}

function fileKey(path) {
  return String(path || '').toLocaleLowerCase();
}

function normalizeBrowseMode(mode) {
  return mode === 'categorized' ? 'categorized' : 'multi';
}

function uniqueFolders(folders) {
  const seen = new Set();
  const result = [];
  for (const folder of folders.filter(Boolean)) {
    const key = fileKey(folder);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(folder);
  }
  return result;
}

function persistMultiFolderFilter() {
  localStorage.setItem('superImageViewer.multiFolderFilter', JSON.stringify([...state.multiFolderFilter]));
}

function loadMultiFolderFilter() {
  try {
    const raw = JSON.parse(localStorage.getItem('superImageViewer.multiFolderFilter') || '[]');
    state.multiFolderFilter = new Set(Array.isArray(raw) ? raw : []);
  } catch {
    state.multiFolderFilter = new Set();
  }
}

function normalizeMultiFolderFilter({ defaultAll = true } = {}) {
  const folderKeys = new Set(state.multiFolders.map(fileKey));
  state.multiFolderFilter = new Set([...state.multiFolderFilter].filter(key => folderKeys.has(key)));
  if (defaultAll && !state.multiFolderFilter.size) {
    state.multiFolderFilter = new Set(folderKeys);
  }
  persistMultiFolderFilter();
}

function enabledMultiFolders() {
  return state.multiFolders.filter(folder => state.multiFolderFilter.has(fileKey(folder)));
}

function setFolderLoading(loading, message = 'Loading...') {
  folderPanel.classList.toggle('loading', loading);
  folderLoading.hidden = !loading;
  folderLoadingText.textContent = message;
}

function setFolderPanelOpen(open) {
  folderPanel.classList.toggle('open', open);
}

function renderFolderButton() {
  let label = 'Folder';
  if (state.browseMode === 'multi') {
    const enabled = enabledMultiFolders();
    label = !state.multiFolders.length
      ? 'Folders'
      : enabled.length === 1
        ? baseName(enabled[0])
        : `${enabled.length}/${state.multiFolders.length} folders`;
  } else {
    label = state.categorizedRoot ? baseName(state.categorizedRoot) : 'Categorized';
  }

  folderButtonLabel.textContent = label;
  btnFolder.classList.toggle('mode-multi', state.browseMode === 'multi');
  btnFolder.classList.toggle('mode-categorized', state.browseMode === 'categorized');
}

function renderFolderPanelSections() {
  folderModeTabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.browseMode === state.viewedBrowseMode);
    tab.classList.toggle('current-mode', tab.dataset.browseMode === state.browseMode);
  });
  folderSectionMulti.classList.toggle('visible', state.viewedBrowseMode === 'multi');
  folderSectionCategorized.classList.toggle('visible', state.viewedBrowseMode === 'categorized');
}

function loadImagePool(images, label, mode, folder = null) {
  clearSlideshowPreload();
  state.allImages = [...images].sort((a, b) => b.modified - a.modified);
  state.folder = folder;
  state.browseMode = mode;
  state.viewedBrowseMode = mode;
  state.chronoOffset = 0;
  hist.stack = [];
  hist.pos = -1;
  folderNameEl.textContent = label;
  document.body.classList.toggle('no-folder', !state.allImages.length);
  renderFolderButton();
  renderFolderPanelSections();
  if (state.allImages.length) refresh();
  else {
    state.displayedSlots = [];
    imageGrid.textContent = '';
    syncNavButtons();
  }
  persistSettings();
}

function renderMultiFolderList() {
  multiFolderListEl.textContent = '';
  normalizeMultiFolderFilter({ defaultAll: false });
  if (!state.multiFolders.length) {
    const empty = document.createElement('div');
    empty.className = 'categories-empty';
    empty.textContent = 'No folders added yet.';
    multiFolderListEl.append(empty);
    return;
  }
  for (const folder of state.multiFolders) {
    const row = document.createElement('div');
    row.className = 'multi-folder-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.multiFolderFilter.has(fileKey(folder));
    checkbox.addEventListener('change', () => toggleMultiFolder(folder));
    const name = document.createElement('span');
    name.className = 'multi-folder-name';
    name.textContent = baseName(folder);
    name.title = folder;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'multi-folder-remove';
    remove.textContent = 'x';
    remove.title = `Remove ${folder}`;
    remove.addEventListener('click', e => {
      e.stopPropagation();
      removeMultiFolder(folder);
    });
    row.append(checkbox, name, remove);
    multiFolderListEl.append(row);
  }
}

async function enterMultiMode() {
  normalizeMultiFolderFilter({ defaultAll: false });
  const folders = enabledMultiFolders();
  if (!folders.length) {
    loadImagePool([], 'No multi-folders enabled', 'multi');
    return;
  }
  setFolderLoading(true, 'Scanning folders...');
  try {
    const images = await window.viewerAPI.listMultiFolderImages(folders);
    loadImagePool(images, `${folders.length} folder${folders.length === 1 ? '' : 's'}`, 'multi');
  } catch (error) {
    showToast('Failed to load folders');
    console.error(error);
  } finally {
    setFolderLoading(false);
  }
}

async function addMultiFolder() {
  const folder = await window.viewerAPI.selectFolder();
  if (!folder) return;
  const key = fileKey(folder);
  if (state.multiFolders.some(item => fileKey(item) === key)) {
    showToast('Folder already added');
    return;
  }
  state.multiFolders.push(folder);
  state.multiFolderFilter.add(key);
  persistMultiFolderFilter();
  renderMultiFolderList();
  await enterMultiMode();
}

async function removeMultiFolder(folder) {
  const key = fileKey(folder);
  state.multiFolders = state.multiFolders.filter(item => fileKey(item) !== key);
  state.multiFolderFilter.delete(key);
  persistMultiFolderFilter();
  renderMultiFolderList();
  await enterMultiMode();
}

async function toggleMultiFolder(folder) {
  const key = fileKey(folder);
  if (state.multiFolderFilter.has(key)) state.multiFolderFilter.delete(key);
  else state.multiFolderFilter.add(key);
  persistMultiFolderFilter();
  renderMultiFolderList();
  await enterMultiMode();
}

function renderCategorizedRootRow() {
  categorizedRootNameEl.textContent = state.categorizedRoot ? baseName(state.categorizedRoot) : 'No root chosen';
  categorizedRootNameEl.title = state.categorizedRoot || '';
}

function renderCategoriesPanel() {
  categoriesList.textContent = '';
  if (!state.categorizedCategories.length) {
    const empty = document.createElement('div');
    empty.className = 'categories-empty';
    empty.textContent = 'No categorized images found.';
    categoriesList.append(empty);
    return;
  }
  for (const category of state.categorizedCategories) {
    const row = document.createElement('label');
    row.className = 'category-checkbox-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.categorizedCategoryFilter.has(category.name);
    checkbox.addEventListener('change', () => toggleCategorizedCategory(category.name));
    const name = document.createElement('span');
    name.className = 'category-checkbox-name';
    name.textContent = category.name;
    const count = document.createElement('span');
    count.className = 'category-checkbox-count';
    count.textContent = category.count;
    row.append(checkbox, name, count);
    categoriesList.append(row);
  }
}

function categorizedFilteredImages() {
  return state.categorizedImages.filter(image => state.categorizedCategoryFilter.has(image.category));
}

async function enterCategorizedMode(root = state.categorizedRoot) {
  if (!root) {
    loadImagePool([], 'No categorized root', 'categorized');
    renderCategorizedRootRow();
    renderCategoriesPanel();
    return;
  }
  setFolderLoading(true, 'Scanning categories...');
  try {
    const scan = await window.viewerAPI.scanCategorizedRoot(root);
    state.categorizedRoot = scan.root;
    state.categorizedImages = scan.images;
    state.categorizedCategories = scan.categories;
    const available = new Set(scan.categories.map(category => category.name));
    const kept = [...state.categorizedCategoryFilter].filter(name => available.has(name));
    state.categorizedCategoryFilter = new Set(kept.length ? kept : [...available]);
    renderCategorizedRootRow();
    renderCategoriesPanel();
    loadImagePool(categorizedFilteredImages(), baseName(scan.root), 'categorized');
  } catch (error) {
    showToast('Failed to load categorized root');
    console.error(error);
  } finally {
    setFolderLoading(false);
  }
}

async function chooseCategorizedRoot() {
  const folder = await window.viewerAPI.selectFolder();
  if (!folder) return;
  await enterCategorizedMode(folder);
}

function applyCategorizedFilter() {
  renderCategoriesPanel();
  loadImagePool(categorizedFilteredImages(), state.categorizedRoot ? baseName(state.categorizedRoot) : 'Categorized', 'categorized');
}

function toggleCategorizedCategory(name) {
  if (state.categorizedCategoryFilter.has(name)) state.categorizedCategoryFilter.delete(name);
  else state.categorizedCategoryFilter.add(name);
  applyCategorizedFilter();
}

function setAllCategorizedCategories(checked) {
  state.categorizedCategoryFilter = checked
    ? new Set(state.categorizedCategories.map(category => category.name))
    : new Set();
  applyCategorizedFilter();
}

// ==============================
// Right-click categorize menu (categorized mode only)
// ==============================
function categoryForPath(path) {
  const entry = state.categorizedImages.find(image => image.path === path);
  return entry ? entry.category : null;
}

function closeGridContextMenu() {
  gridContextMenu.classList.remove('open');
}

function openGridContextMenu(x, y) {
  gridContextMenu.classList.add('open');
  const maxX = window.innerWidth - gridContextMenu.offsetWidth - 4;
  const maxY = window.innerHeight - gridContextMenu.offsetHeight - 4;
  gridContextMenu.style.left = `${Math.max(4, Math.min(x, maxX))}px`;
  gridContextMenu.style.top = `${Math.max(4, Math.min(y, maxY))}px`;
}

function openImageContextMenu(path, x, y) {
  gridContextMenu.textContent = '';

  // Hide — available in every browse mode; view-only, no categorization change.
  const hideBtn = document.createElement('button');
  hideBtn.type = 'button';
  const hideLabel = document.createElement('span');
  hideLabel.textContent = 'Hide image';
  hideBtn.append(hideLabel);
  hideBtn.addEventListener('click', () => {
    closeGridContextMenu();
    hideImage(path);
  });
  gridContextMenu.append(hideBtn);

  // Categorize — only meaningful when browsing a categorized root.
  if (state.browseMode === 'categorized') {
    const separator = document.createElement('div');
    separator.className = 'context-menu-separator';
    gridContextMenu.append(separator);

    const title = document.createElement('div');
    title.className = 'context-menu-title';
    title.textContent = 'Move to category';
    gridContextMenu.append(title);

    if (!state.categorizedCategories.length) {
      const empty = document.createElement('div');
      empty.className = 'context-menu-empty';
      empty.textContent = 'No categories available';
      gridContextMenu.append(empty);
    } else {
      const current = categoryForPath(path);
      for (const category of state.categorizedCategories) {
        const isCurrent = category.name === current;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.classList.toggle('current', isCurrent);
        const name = document.createElement('span');
        name.textContent = category.name;
        const mark = document.createElement('span');
        mark.textContent = isCurrent ? '✓' : '';
        btn.append(name, mark);
        btn.addEventListener('click', () => {
          closeGridContextMenu();
          if (!isCurrent) categorizeImage(path, category.name);
        });
        gridContextMenu.append(btn);
      }
    }
  }

  openGridContextMenu(x, y);
}

// Reflect a category change locally so counts and the filter panel update
// without re-hashing the whole root; the sidecar on disk is the source of
// truth on the next rescan.
function applyLocalCategoryChange(path, category) {
  const entry = state.categorizedImages.find(image => image.path === path);
  const previous = entry ? entry.category : null;
  if (previous === category) return;
  if (entry) entry.category = category;

  if (previous) {
    const prevCategory = state.categorizedCategories.find(item => item.name === previous);
    if (prevCategory) prevCategory.count = Math.max(0, prevCategory.count - 1);
  }
  let nextCategory = state.categorizedCategories.find(item => item.name === category);
  if (!nextCategory) {
    nextCategory = { name: category, count: 0 };
    state.categorizedCategories.push(nextCategory);
  }
  nextCategory.count += 1;

  renderCategoriesPanel();
}

// Keep the current history entry in sync after an in-place slot edit (hide /
// instant filter) so navigating away and back doesn't resurrect the old image.
function syncHistoryHead() {
  if (hist.pos >= 0 && hist.stack[hist.pos]) {
    hist.stack[hist.pos].slots = [...state.displayedSlots];
  }
}

// Pick a fresh image from the current pool that isn't already on screen.
function pickReplacementImage(shownPaths) {
  const candidates = state.allImages.filter(image => !shownPaths.has(image.path));
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)].path;
}

// Drop `path` from the session pool and swap its on-screen slot for a new
// image (or an empty slot if the pool is exhausted). Shared by hide + instant
// filter; never touches categorization on disk.
function removeDisplayedImage(path) {
  const index = state.displayedSlots.indexOf(path);
  state.allImages = state.allImages.filter(image => image.path !== path);
  clearSlideshowPreload();
  if (index === -1) return;
  const shown = new Set(state.displayedSlots.filter(Boolean));
  state.displayedSlots[index] = pickReplacementImage(shown);
  renderGrid(state.displayedSlots);
  syncHistoryHead();
  if (state.slideshow) rescheduleSlideshowTick();
}

function hideImage(path) {
  removeDisplayedImage(path);
}

async function categorizeImage(path, category) {
  if (!state.categorizedRoot) return;
  try {
    await window.viewerAPI.setImageCategory(state.categorizedRoot, path, category);
    applyLocalCategoryChange(path, category);

    const filteredOut = state.browseMode === 'categorized'
      && !state.categorizedCategoryFilter.has(category);
    if (appSettings.instantFilterCategorized && filteredOut) {
      removeDisplayedImage(path);
      showToast(`Moved to ${category} — hidden`);
    } else {
      showToast(`Moved to ${category}`);
    }
  } catch (error) {
    console.error('Failed to categorize image:', error);
    showToast('Failed to categorize image');
  }
}

// ==============================
// Image count (max 99)
// ==============================
function setImageCount(n) {
  n = Math.max(4, Math.min(99, Math.round(n)));
  state.imageCount = n;
  state.emptyCount = Math.min(state.emptyCount, n - 1);
  countDisplayEl.textContent  = n;
  emptyDisplayEl.textContent  = state.emptyCount;
  settingSlider.value         = n;
  settingCountVal.textContent = n;
  if (state.allImages.length) refresh();
  persistSettings();
}

function bumpCount(up) {
  setImageCount(state.imageCount + (up ? 1 : -1));
}

// ==============================
// Inline edit for count displays
// ==============================
function startInlineEdit(el, currentVal, min, max, applyFn) {
  if (el.dataset.editing) return;
  el.dataset.editing = '1';

  const inp = document.createElement('input');
  inp.type = 'number';
  inp.value = currentVal;
  inp.min = min;
  inp.max = max;
  inp.className = 'inline-edit';

  el.textContent = '';
  el.appendChild(inp);
  inp.focus();
  inp.select();

  let committed = false;

  function commit() {
    if (committed) return;
    committed = true;
    delete el.dataset.editing;
    const v = parseInt(inp.value, 10);
    if (!isNaN(v)) applyFn(v);
    else el.textContent = currentVal;
  }

  function cancel() {
    if (committed) return;
    committed = true;
    delete el.dataset.editing;
    el.textContent = currentVal;
  }

  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  inp.addEventListener('blur', commit);
}

// ==============================
// Empty slot count
// ==============================
function setEmptyCount(n) {
  n = Math.max(0, Math.min(state.imageCount - 1, Math.round(n)));
  state.emptyCount       = n;
  emptyDisplayEl.textContent = n;
  if (state.allImages.length) refresh();
  persistSettings();
}

function bumpEmpty(up) {
  setEmptyCount(state.emptyCount + (up ? 1 : -1));
}

// ==============================
// Display mode
// ==============================
function setDisplayMode(mode) {
  state.displayMode  = mode;
  state.chronoOffset = 0;
  hist.stack = [];
  hist.pos   = -1;
  syncModeButtons();
  if (state.allImages.length) refresh();
  persistSettings();
}

function syncModeButtons() {
  btnModeRandom.classList.toggle('active', state.displayMode === 'random');
  btnModeChrono.classList.toggle('active', state.displayMode === 'chrono');
}

function normalizeZoomFillLevel(level) {
  return Math.max(1, Math.min(3, Math.round(level || 2)));
}

function normalizeZoomFillAmount(amount) {
  return Math.max(0, Math.min(100, Math.round(amount || 0)));
}

function snapZoomFillAmount(amount) {
  const normalized = normalizeZoomFillAmount(amount);
  return Math.abs(normalized - ZOOM_FILL_COVER_AT) <= ZOOM_FILL_SNAP_RADIUS
    ? ZOOM_FILL_COVER_AT
    : normalized;
}

function zoomFillAmountForLevel(level) {
  return ZOOM_FILL_PRESETS[normalizeZoomFillLevel(level)];
}

function zoomFillScale(amount) {
  const normalized = normalizeZoomFillAmount(amount);
  if (normalized <= 0) return 1;

  if (normalized < ZOOM_FILL_COVER_AT) {
    const partialProgress = normalized / ZOOM_FILL_COVER_AT;
    const easedProgress = partialProgress * partialProgress;
    return 1 + easedProgress * (ZOOM_FILL_PARTIAL_MAX_SCALE - 1);
  }

  const coverProgress = (normalized - ZOOM_FILL_COVER_AT) / (100 - ZOOM_FILL_COVER_AT);
  return 1 + coverProgress * (ZOOM_FILL_MAX_SCALE - 1);
}

function isZoomFillCover(amount) {
  return normalizeZoomFillAmount(amount) >= ZOOM_FILL_COVER_AT;
}

function zoomFillLevelForAmount(amount) {
  const normalized = normalizeZoomFillAmount(amount);
  let closestLevel = 1;
  let closestDistance = Infinity;

  [1, 2, 3].forEach(level => {
    const distance = Math.abs(normalized - ZOOM_FILL_PRESETS[level]);
    if (distance < closestDistance) {
      closestLevel = level;
      closestDistance = distance;
    }
  });

  return closestLevel;
}

function mapZoomFillAmount(amount, fromStops, toStops) {
  const mappedAmount = normalizeZoomFillAmount(amount);

  for (let i = 1; i < fromStops.length; i++) {
    if (mappedAmount <= fromStops[i]) {
      const fromSpan = fromStops[i] - fromStops[i - 1];
      const toSpan = toStops[i] - toStops[i - 1];
      const progress = fromSpan > 0
        ? (mappedAmount - fromStops[i - 1]) / fromSpan
        : 0;
      return normalizeZoomFillAmount(toStops[i - 1] + progress * toSpan);
    }
  }

  return 100;
}

function migrateLegacyZoomFillAmount(amount) {
  const legacyAmount = normalizeZoomFillAmount(amount);
  const legacyStops = [0, 7, 30, 57, 100];
  const nextStops = [0, ZOOM_FILL_PRESETS[1], ZOOM_FILL_PRESETS[2], ZOOM_FILL_PRESETS[3], 100];

  return mapZoomFillAmount(legacyAmount, legacyStops, nextStops);
}

function migratePreviousZoomFillAmount(amount) {
  return mapZoomFillAmount(amount, [0, 25, 70, 85, 100], [
    0,
    ZOOM_FILL_PRESETS[1],
    ZOOM_FILL_PRESETS[2],
    ZOOM_FILL_PRESETS[3],
    100,
  ]);
}

// v5 used a cover crossover of 86 (fill/Z2 sat exactly on it, with presets 34/86/93).
// v6 moves the crossover to the center of the slider (50) and gives Z2 real crop
// overhead, so old saved amounts need remapping onto the new stops.
function migrateV5ZoomFillAmount(amount) {
  return mapZoomFillAmount(amount, [0, 34, 86, 93, 100], [
    0,
    ZOOM_FILL_PRESETS[1],
    ZOOM_FILL_PRESETS.fill,
    ZOOM_FILL_PRESETS[3],
    100,
  ]);
}

function loadZoomFillAmount(settings) {
  if (Number.isFinite(settings.zoomFillAmount)) {
    if (settings.zoomFillVersion >= 6) {
      return normalizeZoomFillAmount(settings.zoomFillAmount);
    }

    if (settings.zoomFillVersion >= 5) {
      return migrateV5ZoomFillAmount(settings.zoomFillAmount);
    }

    return settings.zoomFillVersion >= 4
      ? migratePreviousZoomFillAmount(settings.zoomFillAmount)
      : migrateLegacyZoomFillAmount(settings.zoomFillAmount);
  }

  if (settings.zoomFillEnabled === false) return 0;

  if (settings.zoomFillVersion >= 2) {
    return zoomFillAmountForLevel(settings.zoomFillLevel);
  }

  if (settings.zoomFillLevel === 2) return zoomFillAmountForLevel(3);
  if (settings.zoomFillLevel === 1) return zoomFillAmountForLevel(2);
  return ZOOM_FILL_PRESETS.fill;
}

function zoomBiasPosition() {
  const amount = Math.max(0, Math.round(appSettings.zoomFillBiasAmount || 0));
  const step = amount * 5 * ZOOM_BIAS_STEP_SCALE;
  switch (appSettings.zoomFillBiasDirection) {
    case 'L': return { x: 50 - step, y: 50 };
    case 'R': return { x: 50 + step, y: 50 };
    case 'U': return { x: 50, y: 50 - step };
    case 'D': return { x: 50, y: 50 + step };
    default: return { x: 50, y: 50 };
  }
}

function zoomPositionForImage(img, basePosition, coverMode) {
  return coverMode ? basePosition : { x: 50, y: 50 };
}

function portraitFillTransformForImage(img, cell, coverMode, basePosition) {
  if (!coverMode || !img || !img.naturalWidth || !img.naturalHeight) return null;
  const rect = cell.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;

  const imageAspect = img.naturalHeight / img.naturalWidth;
  const cellAspect = rect.height / rect.width;
  if (imageAspect <= Math.max(PORTRAIT_AUTO_BIAS_MIN_ASPECT, cellAspect * 1.05)) {
    return null;
  }

  const containScale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
  const coverScale = Math.max(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
  if (containScale <= 0) return null;

  const fillScale = coverScale / containScale;
  const extraScale = Math.min(zoomFillScale(appSettings.zoomFillAmount), PORTRAIT_FILL_MAX_EXTRA_SCALE);
  const scale = fillScale * extraScale;
  const renderedW = img.naturalWidth * containScale * scale;
  const renderedH = img.naturalHeight * containScale * scale;
  const maxTx = Math.max(0, (renderedW - rect.width) / 2);
  const maxTy = Math.max(0, (renderedH - rect.height) / 2);
  const biasStepPercent = 5 * ZOOM_BIAS_STEP_SCALE;
  const userXSteps = (basePosition.x - 50) / biasStepPercent;
  const userYSteps = (basePosition.y - 50) / biasStepPercent;
  const userXOffset = userXSteps * rect.width * PORTRAIT_BIAS_STEP_CELL_RATIO;
  const userYOffset = userYSteps * rect.height * PORTRAIT_BIAS_STEP_CELL_RATIO;

  return {
    scale,
    tx: clamp(-userXOffset, -maxTx, maxTx),
    ty: clamp(maxTy * PORTRAIT_FACE_SAFE_PAN - userYOffset, -maxTy, maxTy),
  };
}

// Below fill, the image is uncropped (object-fit: contain), so there's nothing
// to pan into — instead bias slides a black curtain in from the biased edge.
// Mirrors the cover-mode pan direction: 'L' favors the left, hiding the right.
function zoomCurtainSide() {
  switch (appSettings.zoomFillBiasDirection) {
    case 'L': return 'right';
    case 'R': return 'left';
    case 'U': return 'bottom';
    case 'D': return 'top';
    default:  return null;
  }
}

function zoomCurtainCoverage() {
  const amount = Math.max(0, Math.round(appSettings.zoomFillBiasAmount || 0));
  return Math.min(45, amount * ZOOM_BIAS_STEP_SCALE);
}

function applyCurtainToCell(cell, side, coveragePercent) {
  const curtain = cell.querySelector('.zoom-curtain');
  if (!side || coveragePercent <= 0) {
    if (curtain) curtain.remove();
    return;
  }

  const el = curtain || cell.appendChild(Object.assign(document.createElement('div'), {
    className: 'zoom-curtain',
  }));
  el.style.top = '';
  el.style.right = '';
  el.style.bottom = '';
  el.style.left = '';
  el.style.width = '';
  el.style.height = '';

  if (side === 'left' || side === 'right') {
    el.style.top = '0';
    el.style.bottom = '0';
    el.style.width = `${coveragePercent}%`;
  } else {
    el.style.left = '0';
    el.style.right = '0';
    el.style.height = `${coveragePercent}%`;
  }
  el.style[side] = '0';
}

// Per-image manual pan/zoom (drag + wheel) — layered independently on top of
// the global zoom-fill system. Active state uses object-fit:contain plus a
// direct translate+scale transform so dragging maps 1:1 to screen pixels
// regardless of the current zoom level (translate is applied in the already-
// scaled coordinate system since it's the leftmost transform function).
// We deliberately avoid object-fit:cover here: cover clips the off-axis edges
// before the transform runs, so those pixels are never painted and panning
// only slides the fixed center-crop over the cell background. contain keeps the
// whole image painted, and we scale up by coverScale/containScale to reproduce
// the cover sizing while leaving every edge reachable by panning.
function isManualZoomActive(manual) {
  return !!manual && (manual.resetting || manual.scale !== 1 || manual.tx !== 0 || manual.ty !== 0);
}

function manualZoomOverflow(img, rect, totalScale) {
  const coverScale = Math.max(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
  const renderedW = img.naturalWidth * coverScale * totalScale;
  const renderedH = img.naturalHeight * coverScale * totalScale;
  return {
    maxTx: Math.max(0, (renderedW - rect.width) / 2),
    maxTy: Math.max(0, (renderedH - rect.height) / 2),
  };
}

function applyManualOverride(cell) {
  const img = cell.querySelector('img');
  if (!img) return false;
  const manual = imageManualZoom.get(img);
  const active = isManualZoomActive(manual);
  const wasManual = cell.classList.contains('manual-zoom');
  cell.classList.toggle('manual-zoom', active);
  if (!active) {
    if (wasManual) {
      img.style.objectFit = '';
      img.style.transform = '';
    }
    return false;
  }
  const totalScale = zoomFillScale(appSettings.zoomFillAmount) * manual.scale;
  const rect = cell.getBoundingClientRect();
  const containScale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
  const coverScale = Math.max(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
  const resetToContainFit = manual.resetting && !isZoomFillCover(appSettings.zoomFillAmount);
  // contain paints the whole image at containScale; scaling by coverScale/
  // containScale brings it to the cover size manualZoomOverflow assumes, so the
  // pan clamp matches what's actually on screen and no edge is unreachable.
  const renderScale = resetToContainFit
    ? totalScale
    : containScale > 0
    ? (coverScale / containScale) * totalScale
    : totalScale;
  img.style.objectFit = 'contain';
  img.style.objectPosition = '50% 50%';
  img.style.transformOrigin = '50% 50%';
  img.style.transform = `translate(${manual.tx}px, ${manual.ty}px) scale(${renderScale})`;
  return true;
}

function recenterManualZoom(cell) {
  const img = cell && cell.querySelector('img');
  if (!img || !imageManualZoom.has(img)) return;
  clearImageManualZoom(img, true);
  applyZoomFillToImages();
}

function cellHasManualZoom(cell) {
  const img = cell && cell.querySelector('img');
  return !!img && imageManualZoom.has(img);
}

function recenterAllManualZoom() {
  let changed = false;
  imageGrid.querySelectorAll('.grid-cell img').forEach(img => {
    if (imageManualZoom.has(img)) {
      clearImageManualZoom(img, true);
      changed = true;
    }
  });
  if (changed) applyZoomFillToImages();
}

function applyZoomFillToImages() {
  const coverMode = isZoomFillCover(appSettings.zoomFillAmount);
  const position = coverMode ? zoomBiasPosition() : { x: 50, y: 50 };
  imageGrid.style.setProperty('--zoom-fill-x', `${position.x}%`);
  imageGrid.style.setProperty('--zoom-fill-y', `${position.y}%`);

  const curtainSide = coverMode ? null : zoomCurtainSide();
  const curtainCoverage = curtainSide ? zoomCurtainCoverage() : 0;

  imageGrid.querySelectorAll('.grid-cell').forEach(cell => {
    const img = cell.querySelector('img');
    if (img) {
      const imgPosition = zoomPositionForImage(img, position, coverMode);
      const imgPositionValue = `${imgPosition.x}% ${imgPosition.y}%`;
      const portraitFill = portraitFillTransformForImage(img, cell, coverMode, position);
      if (portraitFill !== null) {
        img.style.objectFit = 'contain';
        img.style.objectPosition = '50% 50%';
        img.style.transformOrigin = '50% 50%';
        img.style.transform = `translate(${portraitFill.tx}px, ${portraitFill.ty}px) scale(${portraitFill.scale})`;
      } else {
        img.style.objectFit = '';
        img.style.transform = '';
        img.style.objectPosition = imgPositionValue;
        img.style.transformOrigin = imgPositionValue;
      }
    }
    const manualActive = manualZoomActiveCount > 0 && applyManualOverride(cell);
    applyCurtainToCell(cell, img && !manualActive ? curtainSide : null, curtainCoverage);
  });
}

function syncZoomFillControls() {
  const fillAmount = normalizeZoomFillAmount(Number.isFinite(appSettings.zoomFillAmount)
    ? appSettings.zoomFillAmount
    : ZOOM_FILL_PRESETS.fill);
  const fillEnabled = fillAmount > 0;
  const coverEnabled = isZoomFillCover(fillAmount);
  const level = zoomFillLevelForAmount(fillAmount);
  const amount = Math.max(0, Math.round(appSettings.zoomFillBiasAmount || 0));
  const direction = amount > 0 ? appSettings.zoomFillBiasDirection : '';

  appSettings.zoomFillLevel = level;
  appSettings.zoomFillAmount = fillAmount;
  appSettings.zoomFillEnabled = fillEnabled;
  imageGrid.style.setProperty('--zoom-fill-active-scale', zoomFillScale(fillAmount).toFixed(3));
  document.body.classList.toggle('zoom-fill', fillEnabled);
  document.body.classList.toggle('zoom-fill-cover', coverEnabled);
  applyZoomFillToImages();

  btnZoomFill.classList.toggle('active', fillEnabled);
  btnZoomFill.textContent = fillEnabled ? 'Fill' : 'Fit';
  btnZoomFill.title = coverEnabled
    ? 'Zoom to fill is on'
    : fillEnabled
      ? 'Partial zoom is on'
      : 'Zoom to fill is off';
  btnZoomLevel1.classList.toggle('active', fillEnabled && fillAmount === ZOOM_FILL_PRESETS[1]);
  btnZoomLevel2.classList.toggle('active', fillEnabled && fillAmount === ZOOM_FILL_PRESETS[2]);
  btnZoomLevel3.classList.toggle('active', fillEnabled && fillAmount === ZOOM_FILL_PRESETS[3]);
  zoomFillSlider.value = String(fillAmount);
  zoomFillSlider.title = fillEnabled
    ? `Zoom to fill amount ${fillAmount}`
    : 'No zoom to fill';
  zoomBiasLetter.textContent = direction;
  zoomBiasValue.textContent = String(amount);
}

function setZoomFillEnabled(enabled) {
  appSettings.zoomFillAmount = enabled ? ZOOM_FILL_PRESETS.fill : 0;
  syncZoomFillControls();
  persistSettings();
}

function setZoomFillLevel(level) {
  appSettings.zoomFillAmount = zoomFillAmountForLevel(level);
  syncZoomFillControls();
  persistSettings();
}

function setZoomFillAmount(amount, shouldPersist = true) {
  appSettings.zoomFillAmount = normalizeZoomFillAmount(amount);
  syncZoomFillControls();
  if (shouldPersist) persistSettings();
}

function nudgeZoomBias(direction, shouldPersist = true) {
  if (!['L', 'R', 'U', 'D'].includes(direction)) return;
  const opposites = { L: 'R', R: 'L', U: 'D', D: 'U' };
  const currentDirection = appSettings.zoomFillBiasDirection;
  const currentAmount = Math.max(0, Math.round(appSettings.zoomFillBiasAmount || 0));

  if (!currentDirection || currentAmount === 0) {
    appSettings.zoomFillBiasDirection = direction;
    appSettings.zoomFillBiasAmount = 1;
  } else if (currentDirection === direction) {
    appSettings.zoomFillBiasAmount = currentAmount + 1;
  } else if (opposites[currentDirection] === direction) {
    const nextAmount = currentAmount - 1;
    appSettings.zoomFillBiasDirection = nextAmount > 0 ? currentDirection : '';
    appSettings.zoomFillBiasAmount = Math.max(0, nextAmount);
  } else {
    appSettings.zoomFillBiasDirection = direction;
    appSettings.zoomFillBiasAmount = 1;
  }
  appSettings.zoomFillEnabled = true;
  syncZoomFillControls();
  if (shouldPersist) persistSettings();
}

function stopZoomBiasRepeat() {
  if (zoomBiasHoldTimer === null && zoomBiasRepeatTimer === null) return;
  if (zoomBiasHoldTimer !== null) {
    clearTimeout(zoomBiasHoldTimer);
    zoomBiasHoldTimer = null;
  }
  if (zoomBiasRepeatTimer !== null) {
    clearInterval(zoomBiasRepeatTimer);
    zoomBiasRepeatTimer = null;
  }
  zoomBiasRepeatPointerId = null;
  persistSettings();
}

function startZoomBiasRepeat(button, pointerId) {
  const direction = button.dataset.biasDirection;
  if (!direction) return;

  stopZoomBiasRepeat();
  zoomBiasRepeatPointerId = pointerId;
  nudgeZoomBias(direction, false);

  // Wait before auto-repeating so a quick click only nudges once — without
  // this, a click slightly longer than the repeat interval double-steps.
  zoomBiasHoldTimer = setTimeout(() => {
    zoomBiasHoldTimer = null;
    zoomBiasRepeatTimer = setInterval(() => {
      nudgeZoomBias(direction, false);
    }, ZOOM_BIAS_REPEAT_MS);
  }, ZOOM_BIAS_HOLD_DELAY_MS);

  try {
    button.setPointerCapture(pointerId);
  } catch { /* ignore */ }
}

// ==============================
// UI toggle (Shift+Q)
// ==============================
function setUiHidden(hidden) {
  state.uiHidden = hidden;
  document.body.classList.toggle('ui-hidden', hidden);
}

// ==============================
// Settings panel
// ==============================
function setSettingsOpen(open) {
  state.settingsOpen = open;
  settingsPanel.classList.toggle('open', open);
  btnSettings.classList.toggle('active', open);
}

// ==============================
// Persist settings
// ==============================
async function persistSettings() {
  if (!startupDone) return;
  try {
    await window.viewerAPI.saveSettings({
      folder:            state.folder,
      browseMode:        state.browseMode,
      multiFolders:      state.multiFolders,
      multiFolderFilter: [...state.multiFolderFilter],
      categorizedRoot:   state.categorizedRoot,
      categorizedCategoryFilter: [...state.categorizedCategoryFilter],
      startupBrowseMode: appSettings.startupBrowseMode,
      startupFolder:     null,
      startupMultiFolders: appSettings.startupMultiFolders,
      startupMultiFolderFilter: appSettings.startupMultiFolderFilter,
      startupCategorizedRoot: appSettings.startupCategorizedRoot,
      startupCategorizedCategoryFilter: appSettings.startupCategorizedCategoryFilter,
      imageCount:        state.imageCount,
      emptyCount:        state.emptyCount,
      displayMode:       state.displayMode,
      slideshowDuration: state.slideshowDuration,
      zoomFillEnabled: appSettings.zoomFillEnabled,
      zoomFillLevel: appSettings.zoomFillLevel,
      zoomFillAmount: appSettings.zoomFillAmount,
      zoomFillVersion: appSettings.zoomFillVersion,
      zoomFillBiasDirection: appSettings.zoomFillBiasDirection,
      zoomFillBiasAmount: appSettings.zoomFillBiasAmount,
      squareAppCorners:  appSettings.squareAppCorners,
      firstAutoOpenSlideshow: appSettings.firstAutoOpenSlideshow,
      secondaryAutoOpenSlideshow: appSettings.secondaryAutoOpenSlideshow,
      autoSlideshowSource: appSettings.autoSlideshowSource,
      autoHideUiOnStartup: appSettings.autoHideUiOnStartup,
      instantFilterCategorized: appSettings.instantFilterCategorized,
      firstDisplayFolderEnabled: false,
      firstDisplayFolder: null,
      secondaryDisplayFolderEnabled: false,
      secondaryDisplayFolder: null,
    });
  } catch { /* ignore */ }
}

async function addStartupSlideshowFolder() {
  const folder = await window.viewerAPI.selectFolder();
  if (!folder) return;

  const key = fileKey(folder);
  if (!appSettings.startupMultiFolders.some(item => fileKey(item) === key)) {
    appSettings.startupMultiFolders.push(folder);
  }
  appSettings.startupMultiFolderFilter = [key];
  appSettings.startupBrowseMode = 'multi';
  appSettings.autoSlideshowSource = 'folders';

  syncStartupSourceSettings();
  await persistSettings();
  showToast('Set slideshow startup folder');
}

async function useCurrentSourceAtStartup() {
  appSettings.startupBrowseMode = state.browseMode;
  appSettings.autoSlideshowSource = state.browseMode === 'categorized' ? 'categorized' : 'folders';

  if (state.browseMode === 'multi') {
    appSettings.startupMultiFolders = [...state.multiFolders];
    appSettings.startupMultiFolderFilter = [...state.multiFolderFilter];
  } else if (state.browseMode === 'categorized') {
    appSettings.startupCategorizedRoot = state.categorizedRoot;
    appSettings.startupCategorizedCategoryFilter = [...state.categorizedCategoryFilter];
  }

  syncStartupSourceSettings();
  await persistSettings();
  showToast('Saved startup source');
}

async function saveWindowPositionPreset(preset) {
  try {
    await window.viewerAPI.saveWindowPositionPreset(preset);
    showToast(preset === 'first' ? 'Saved 1st window default' : 'Saved 2nd+ window default');
  } catch {
    showToast('Failed to save window default');
  }
}

async function resetWindowPositionPreset(preset) {
  try {
    await window.viewerAPI.resetWindowPositionPreset(preset);
    showToast(preset === 'first' ? 'Reset 1st window default' : 'Reset 2nd+ window default');
  } catch {
    showToast('Failed to reset window default');
  }
}

// ==============================
// Toast
// ==============================
function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  t.addEventListener('animationend', () => t.remove());
}

// ==============================
// Event listeners
// ==============================
document.addEventListener('pointerdown', e => {
  const button = e.target.closest('button');
  if (button) e.preventDefault();
});

document.addEventListener('click', e => {
  const button = e.target.closest('button');
  if (button) button.blur();
});

document.getElementById('titlebar-drag').addEventListener('mousedown', e => {
  if (e.button === 0) window.viewerAPI.windowStartDrag();
});

btnMinimize.addEventListener('click', () => window.viewerAPI.windowMinimize());
btnClose.addEventListener('click',    () => window.viewerAPI.windowClose());

btnFolder.addEventListener('click', e => {
  e.stopPropagation();
  setFolderPanelOpen(!folderPanel.classList.contains('open'));
});
btnOpenEmpty.addEventListener('click', addMultiFolder);
folderMultiAdd.addEventListener('click', addMultiFolder);
categorizedRootChoose.addEventListener('click', chooseCategorizedRoot);
categoriesSelectAll.addEventListener('click', () => setAllCategorizedCategories(true));
categoriesSelectNone.addEventListener('click', () => setAllCategorizedCategories(false));
categoriesRescan.addEventListener('click', () => enterCategorizedMode());
folderModeTabs.forEach(tab => {
  tab.addEventListener('click', async () => {
    state.viewedBrowseMode = tab.dataset.browseMode;
    renderFolderPanelSections();
    if (state.viewedBrowseMode === 'multi') await enterMultiMode();
    if (state.viewedBrowseMode === 'categorized') await enterCategorizedMode();
  });
});

btnCountDec.addEventListener('click', () => bumpCount(false));
btnCountInc.addEventListener('click', () => bumpCount(true));
countDisplayEl.addEventListener('click', () =>
  startInlineEdit(countDisplayEl, state.imageCount, 4, 99, setImageCount));

btnEmptyDec.addEventListener('click', () => bumpEmpty(false));
btnEmptyInc.addEventListener('click', () => bumpEmpty(true));
emptyDisplayEl.addEventListener('click', () =>
  startInlineEdit(emptyDisplayEl, state.emptyCount, 0, state.imageCount - 1, setEmptyCount));

btnModeRandom.addEventListener('click', () => setDisplayMode('random'));
btnModeChrono.addEventListener('click', () => setDisplayMode('chrono'));

btnZoomFill.addEventListener('click', () => {
  setZoomFillAmount(ZOOM_FILL_PRESETS.fill);
});

btnZoomLevel1.addEventListener('click', () => setZoomFillLevel(1));
btnZoomLevel2.addEventListener('click', () => setZoomFillLevel(2));
btnZoomLevel3.addEventListener('click', () => setZoomFillLevel(3));

zoomFillSlider.addEventListener('input', () => {
  setZoomFillAmount(snapZoomFillAmount(zoomFillSlider.value), false);
});

zoomFillSlider.addEventListener('change', () => {
  setZoomFillAmount(snapZoomFillAmount(zoomFillSlider.value));
  zoomFillSlider.blur();
});

zoomBiasControl.addEventListener('pointerdown', e => {
  const button = e.target.closest('button[data-bias-direction]');
  if (!button) return;
  e.preventDefault();
  e.stopPropagation();
  startZoomBiasRepeat(button, e.pointerId);
});

zoomBiasControl.addEventListener('pointerup', e => {
  if (e.pointerId === zoomBiasRepeatPointerId) stopZoomBiasRepeat();
});

zoomBiasControl.addEventListener('pointercancel', e => {
  if (e.pointerId === zoomBiasRepeatPointerId) stopZoomBiasRepeat();
});

zoomBiasControl.addEventListener('lostpointercapture', e => {
  if (e.pointerId === zoomBiasRepeatPointerId) stopZoomBiasRepeat();
});

window.addEventListener('blur', stopZoomBiasRepeat);

document.getElementById('zoom-bias-display').addEventListener('click', e => {
  e.stopPropagation();
  appSettings.zoomFillBiasDirection = '';
  appSettings.zoomFillBiasAmount = 0;
  syncZoomFillControls();
  persistSettings();
});

btnSlideshow.addEventListener('click', toggleSlideshow);
btnShuffle.addEventListener('click',   shuffleCurrent);
btnRefresh.addEventListener('click',   refresh);

btnNavPrev.addEventListener('click', navigateBack);
btnNavNext.addEventListener('click', navigateForward);

btnSettings.addEventListener('click', e => {
  e.stopPropagation();
  setSettingsOpen(!state.settingsOpen);
});

settingSaveFirstWindow.addEventListener('click', e => {
  e.stopPropagation();
  saveWindowPositionPreset('first');
});

settingResetFirstWindow.addEventListener('click', e => {
  e.stopPropagation();
  resetWindowPositionPreset('first');
});

settingSaveSecondaryWindow.addEventListener('click', e => {
  e.stopPropagation();
  saveWindowPositionPreset('secondary');
});

settingResetSecondaryWindow.addEventListener('click', e => {
  e.stopPropagation();
  resetWindowPositionPreset('secondary');
});

settingSquareAppCorners.addEventListener('change', async () => {
  appSettings.squareAppCorners = settingSquareAppCorners.checked;
  await persistSettings();
  await window.viewerAPI.setWindowSquareCorners(appSettings.squareAppCorners).catch(() => {});
});

settingFirstAutoOpenSlideshow.addEventListener('change', async () => {
  appSettings.firstAutoOpenSlideshow = settingFirstAutoOpenSlideshow.checked;
  syncAutoSlideshowSourceSettings();
  await persistSettings();
});

settingSecondaryAutoOpenSlideshow.addEventListener('change', async () => {
  appSettings.secondaryAutoOpenSlideshow = settingSecondaryAutoOpenSlideshow.checked;
  syncAutoSlideshowSourceSettings();
  await persistSettings();
});

settingAutoHideUi.addEventListener('change', async () => {
  appSettings.autoHideUiOnStartup = settingAutoHideUi.checked;
  await persistSettings();
});

settingInstantFilter.addEventListener('change', async () => {
  appSettings.instantFilterCategorized = settingInstantFilter.checked;
  await persistSettings();
});

settingAutoSlideshowSource.addEventListener('change', async () => {
  appSettings.autoSlideshowSource = settingAutoSlideshowSource.value;
  syncAutoSlideshowSourceSettings();
  await persistSettings();
});

settingAutoSlideshowFolderNeeded.addEventListener('click', e => {
  e.stopPropagation();
  addStartupSlideshowFolder();
});

settingStartupBrowseMode.addEventListener('change', async () => {
  appSettings.startupBrowseMode = settingStartupBrowseMode.value;
  appSettings.autoSlideshowSource = appSettings.startupBrowseMode === 'categorized'
    ? 'categorized'
    : 'folders';
  syncStartupSourceSettings();
  await persistSettings();
});

settingUseCurrentSource.addEventListener('click', e => {
  e.stopPropagation();
  useCurrentSourceAtStartup();
});

settingSlider.addEventListener('input', () => {
  const v = parseInt(settingSlider.value, 10);
  settingCountVal.textContent = v;
  setImageCount(v);
});

settingSlideshowDur.addEventListener('change', () => {
  const sec = Math.max(1, parseInt(settingSlideshowDur.value, 10) || 5);
  settingSlideshowDur.value  = sec;
  state.slideshowDuration    = sec * 1000;
  if (state.slideshow) rescheduleSlideshowTick();
  persistSettings();
});

settingsPanel.addEventListener('click', e => e.stopPropagation());
folderPanel.addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', () => {
  setSettingsOpen(false);
  setFolderPanelOpen(false);
  closeGridContextMenu();
});

// Suppress the native webview context menu everywhere (removes "More tools"
// and "Inspect"). Right-clicking an image opens a custom menu: Hide in any
// mode, plus move-to-category when browsing a categorized root.
document.addEventListener('contextmenu', e => {
  e.preventDefault();

  // A right-click while the menu is open dismisses it instead of reopening.
  if (gridContextMenu.classList.contains('open')) {
    closeGridContextMenu();
    return;
  }

  const cell = e.target.closest && e.target.closest('.grid-cell');
  if (!cell || cell.classList.contains('empty-slot')) return;
  const img = cell.querySelector('img');
  const path = img && img.getAttribute('data-src');
  if (!path) return;

  openImageContextMenu(path, e.clientX, e.clientY);
});

// Keep the menu glued to where it was opened rather than letting it drift on
// scroll/resize; simplest is to just dismiss it.
window.addEventListener('resize', closeGridContextMenu);
imageGrid.addEventListener('scroll', closeGridContextMenu, true);

// ==============================
// Keyboard shortcuts
// ==============================
document.addEventListener('keydown', e => {
  const focused = document.activeElement;
  if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) return;

  // Shift+Q — toggle title bar + toolbar
  if ((e.key === 'Q' || e.key === 'q') && e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    setUiHidden(!state.uiHidden);
    return;
  }

  // Space — new set
  if (e.key === ' ' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    refresh();
    return;
  }

  // C — recenter the hovered image, or the most recently panned/zoomed image
  if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey) {
    const targetCell = cellHasManualZoom(hoveredCell) ? hoveredCell : lastManualZoomCell;
    if (targetCell) {
      e.preventDefault();
      recenterManualZoom(targetCell);
    }
    return;
  }

  // H — recenter the manual pan/zoom of every displayed image
  if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    recenterAllManualZoom();
    return;
  }

  // Escape — unwind modals one level at a time
  if (e.key === 'Escape') {
    e.preventDefault();
    if (gridContextMenu.classList.contains('open')) { closeGridContextMenu(); return; }
    if (state.settingsOpen) { setSettingsOpen(false); return; }
    if (state.uiHidden)     { setUiHidden(false);     return; }
    return;
  }

  // ← → — navigate history
  if (e.key === 'ArrowLeft' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    navigateBack();
    return;
  }
  if (e.key === 'ArrowRight' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    navigateForward();
    return;
  }

  // S — shuffle
  if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    e.preventDefault();
    shuffleCurrent();
    return;
  }

  // P — toggle slideshow (Play/Pause)
  if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    toggleSlideshow();
    return;
  }
});

// ==============================
// Startup
// ==============================
(async () => {
  try {
    windowLabel = await window.viewerAPI.getWindowLabel().catch(() => 'main');
    const s = await window.viewerAPI.loadSettings();

    state.imageCount       = Math.max(4, Math.min(99, s.imageCount || 9));
    state.emptyCount       = Math.max(0, Math.min(state.imageCount - 1, s.emptyCount || 0));
    state.displayMode      = s.displayMode || 'random';
    state.browseMode       = normalizeBrowseMode(s.browseMode);
    state.viewedBrowseMode = state.browseMode;
    state.multiFolders     = uniqueFolders([
      ...(Array.isArray(s.multiFolders) ? s.multiFolders : []),
      s.folder,
    ]);
    if (Array.isArray(s.multiFolderFilter)) {
      state.multiFolderFilter = new Set(s.multiFolderFilter);
    } else {
      loadMultiFolderFilter();
    }
    normalizeMultiFolderFilter({ defaultAll: true });
    state.categorizedRoot  = s.categorizedRoot || null;
    state.categorizedCategoryFilter = new Set(Array.isArray(s.categorizedCategoryFilter) ? s.categorizedCategoryFilter : []);
    state.slideshowDuration = Math.max(1000, s.slideshowDuration || 5000);
    appSettings.squareAppCorners = !!s.squareAppCorners;
    appSettings.zoomFillVersion = 6;
    appSettings.zoomFillAmount = loadZoomFillAmount(s);
    appSettings.zoomFillEnabled = appSettings.zoomFillAmount > 0;
    appSettings.zoomFillLevel = zoomFillLevelForAmount(appSettings.zoomFillAmount);
    appSettings.zoomFillBiasDirection = ['L', 'R', 'U', 'D'].includes(s.zoomFillBiasDirection)
      ? s.zoomFillBiasDirection
      : '';
    appSettings.zoomFillBiasAmount = appSettings.zoomFillBiasDirection
      ? Math.max(0, Math.round(s.zoomFillBiasAmount || 0))
      : 0;
    appSettings.firstAutoOpenSlideshow = !!(s.firstAutoOpenSlideshow || s.autoOpenSlideshow);
    appSettings.secondaryAutoOpenSlideshow = !!s.secondaryAutoOpenSlideshow;
    const loadedStartupBrowseMode = normalizeBrowseMode(s.startupBrowseMode);
    const loadedAutoSource = ['folders', 'categorized'].includes(s.autoSlideshowSource)
      ? s.autoSlideshowSource
      : loadedStartupBrowseMode === 'categorized'
        ? 'categorized'
        : 'folders';
    appSettings.autoSlideshowSource = loadedStartupBrowseMode === 'categorized'
      ? 'categorized'
      : loadedAutoSource;
    appSettings.autoHideUiOnStartup = !!s.autoHideUiOnStartup;
    appSettings.instantFilterCategorized = s.instantFilterCategorized !== false;
    appSettings.startupBrowseMode = loadedStartupBrowseMode;
    appSettings.startupMultiFolders = uniqueFolders([
      ...(Array.isArray(s.startupMultiFolders) ? s.startupMultiFolders : []),
      s.startupFolder,
      s.firstDisplayFolderEnabled ? s.firstDisplayFolder : null,
      s.secondaryDisplayFolderEnabled ? s.secondaryDisplayFolder : null,
      s.folder,
    ]);
    const savedStartupFilter = Array.isArray(s.startupMultiFolderFilter) ? s.startupMultiFolderFilter : [];
    appSettings.startupMultiFolderFilter = savedStartupFilter.length
      ? savedStartupFilter
      : appSettings.startupMultiFolders.map(fileKey);
    appSettings.startupCategorizedRoot = s.startupCategorizedRoot || null;
    appSettings.startupCategorizedCategoryFilter = Array.isArray(s.startupCategorizedCategoryFilter)
      ? s.startupCategorizedCategoryFilter
      : [];

    // Sync UI without triggering refresh/persist
    countDisplayEl.textContent   = state.imageCount;
    emptyDisplayEl.textContent   = state.emptyCount;
    settingSlider.value          = state.imageCount;
    settingCountVal.textContent  = state.imageCount;
    settingSlideshowDur.value    = Math.round(state.slideshowDuration / 1000);
    settingSquareAppCorners.checked = appSettings.squareAppCorners;
    settingFirstAutoOpenSlideshow.checked = appSettings.firstAutoOpenSlideshow;
    settingSecondaryAutoOpenSlideshow.checked = appSettings.secondaryAutoOpenSlideshow;
    settingAutoSlideshowSource.value = appSettings.autoSlideshowSource;
    settingAutoHideUi.checked = appSettings.autoHideUiOnStartup;
    settingInstantFilter.checked = appSettings.instantFilterCategorized;
    renderMultiFolderList();
    renderCategorizedRootRow();
    renderCategoriesPanel();
    renderFolderPanelSections();
    renderFolderButton();
    syncStartupSourceSettings();
    syncSlideshowButton();
    syncModeButtons();
    syncZoomFillControls();
    syncNavButtons();
    if (appSettings.autoHideUiOnStartup) {
      setUiHidden(true);
    }
    await window.viewerAPI.setWindowSquareCorners(appSettings.squareAppCorners).catch(() => {});

    if (shouldAutoStartSlideshow() && (windowLabel === 'main' || isSecondWindow())) {
      await loadAutoSlideshowSource();
    } else if ((windowLabel === 'main' || isSecondWindow()) && hasConfiguredStartupSource()) {
      await loadConfiguredStartupSource();
    } else {
      if (windowLabel === 'main' || isSecondWindow()) {
        if (state.browseMode === 'multi' && state.multiFolders.length) {
          await enterMultiMode();
        } else if (state.browseMode === 'categorized' && state.categorizedRoot) {
          await enterCategorizedMode();
        } else {
          clearDisplayFolder();
        }
      } else {
        clearDisplayFolder();
      }
    }
  } catch {
    renderMultiFolderList();
    renderCategorizedRootRow();
    renderCategoriesPanel();
    renderFolderPanelSections();
    renderFolderButton();
    syncStartupSourceSettings();
    syncSlideshowButton();
    syncModeButtons();
    syncZoomFillControls();
    syncNavButtons();
  } finally {
    document.body.classList.remove('app-starting');
  }

  startupDone = true;
  if (shouldAutoStartSlideshow() && state.allImages.length) {
    startSlideshow();
  }
})();
