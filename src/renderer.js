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

// ==============================
// State
// ==============================
const state = {
  folder:     null,
  allImages:  [],          // [{path, modified}] newest-first

  imageCount: 9,
  emptyCount: 0,
  displayMode: 'random',  // 'random' | 'chrono'
  chronoOffset: 0,        // index into allImages for chrono mode

  displayedSlots: [],     // (string|null)[] — null = intentional empty slot

  slideshow:         false,
  slideshowDuration: 5000,
  slideshowTimer:    null,

  uiHidden:     false,
  settingsOpen: false,
};

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
  autoHideUiOnStartup: false,
  firstDisplayFolderEnabled: false,
  firstDisplayFolder: null,
  secondaryDisplayFolderEnabled: false,
  secondaryDisplayFolder: null,
};

// ==============================
// DOM references
// ==============================
const imageGrid          = document.getElementById('image-grid');
const folderNameEl       = document.getElementById('folder-name');
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
const settingFirstAutoOpenSlideshow = document.getElementById('setting-first-auto-open-slideshow');
const settingSecondaryAutoOpenSlideshow = document.getElementById('setting-secondary-auto-open-slideshow');
const settingFirstFolderEnabled    = document.getElementById('setting-first-folder-enabled');
const settingFirstFolderName       = document.getElementById('setting-first-folder-name');
const settingBrowseFirstFolder     = document.getElementById('setting-browse-first-folder');
const settingSecondaryFolderEnabled = document.getElementById('setting-secondary-folder-enabled');
const settingSecondaryFolderName   = document.getElementById('setting-secondary-folder-name');
const settingBrowseSecondaryFolder = document.getElementById('setting-browse-secondary-folder');
const settingSlider      = document.getElementById('setting-count-slider');
const settingCountVal    = document.getElementById('setting-count-value');
const settingSlideshowDur = document.getElementById('setting-slideshow-duration');
const btnMinimize        = document.getElementById('btn-minimize');
const btnClose           = document.getElementById('btn-close');

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
function generateSlots() {
  const total   = state.imageCount;
  const empties = Math.min(state.emptyCount, total - 1);
  const imgN    = total - empties;

  const paths = state.displayMode === 'random'
    ? pickRandom(imgN)
    : pickChrono(imgN, state.chronoOffset);

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

function restoreEntry(entry) {
  state.displayedSlots = [...entry.slots];
  state.chronoOffset   = entry.chronoOffset;
  renderGrid(state.displayedSlots);
}

function syncNavButtons() {
  btnNavPrev.disabled = hist.pos <= 0;
}

function displayFolderName(folder) {
  return folder ? folder.replace(/\\/g, '/').split('/').pop() : 'None';
}

function syncStartupFolderSettings() {
  settingFirstFolderEnabled.checked = appSettings.firstDisplayFolderEnabled;
  settingFirstFolderName.textContent = displayFolderName(appSettings.firstDisplayFolder);
  settingFirstFolderName.title = appSettings.firstDisplayFolder || 'No folder selected';
  settingBrowseFirstFolder.disabled = !appSettings.firstDisplayFolderEnabled;

  settingSecondaryFolderEnabled.checked = appSettings.secondaryDisplayFolderEnabled;
  settingSecondaryFolderName.textContent = displayFolderName(appSettings.secondaryDisplayFolder);
  settingSecondaryFolderName.title = appSettings.secondaryDisplayFolder || 'No folder selected';
  settingBrowseSecondaryFolder.disabled = !appSettings.secondaryDisplayFolderEnabled;
}

function isSecondWindow() {
  return windowLabel === 'viewer-1';
}

function startupFolderForWindow() {
  if (windowLabel === 'main') {
    return appSettings.firstDisplayFolderEnabled && appSettings.firstDisplayFolder
      ? appSettings.firstDisplayFolder
      : null;
  }

  if (!isSecondWindow()) {
    return null;
  }

  const enabled = appSettings.secondaryDisplayFolderEnabled;
  const folder = appSettings.secondaryDisplayFolder;
  return enabled && folder ? folder : null;
}

function shouldAutoStartSlideshow() {
  if (windowLabel === 'main') {
    return appSettings.firstAutoOpenSlideshow;
  }
  return isSecondWindow() && appSettings.secondaryAutoOpenSlideshow;
}

// ==============================
// Render grid
// ==============================
function renderGrid(slots) {
  applyGridLayout(slots.length || state.imageCount);

  const existing = [...imageGrid.querySelectorAll('.grid-cell')];

  // Remove excess cells
  for (let i = slots.length; i < existing.length; i++) existing[i].remove();

  slots.forEach((slot, i) => {
    let cell = i < existing.length ? existing[i] : (() => {
      const c = document.createElement('div');
      c.className = 'grid-cell';
      imageGrid.appendChild(c);
      return c;
    })();

    if (slot === null) {
      cell.classList.add('empty-slot');
      const img = cell.querySelector('img');
      if (img) img.remove();
    } else {
      cell.classList.remove('empty-slot');
      let img = cell.querySelector('img');
      if (!img) {
        img = document.createElement('img');
        img.draggable = false;
        cell.appendChild(img);
      }
      if (img.getAttribute('data-src') !== slot) {
        img.setAttribute('data-src', slot);
        img.classList.remove('loaded');
        img.onload  = () => img.classList.add('loaded');
        img.onerror = () => {};
        img.src = window.viewerAPI.getFileUrl(slot);
      }
    }
  });
  applyZoomFillToImages();
}

// ==============================
// Refresh — generate a new set
// ==============================
function refresh() {
  if (!state.allImages.length) return;
  const slots = generateSlots();
  state.displayedSlots = slots;
  renderGrid(slots);
  pushHistory(slots, state.chronoOffset);
  rescheduleSlideshowTick();
}

// ==============================
// Navigation (← →)
// ==============================
function navigateBack() {
  if (hist.pos <= 0) return;
  hist.pos--;
  restoreEntry(hist.stack[hist.pos]);
  syncNavButtons();
  rescheduleSlideshowTick();
}

function navigateForward() {
  if (hist.pos < hist.stack.length - 1) {
    // Re-play a set from history
    hist.pos++;
    restoreEntry(hist.stack[hist.pos]);
    syncNavButtons();
  } else {
    // At the head — generate a new set
    if (state.displayMode === 'chrono') {
      const step = Math.max(1, state.imageCount - state.emptyCount);
      state.chronoOffset = Math.min(
        state.allImages.length - 1,
        state.chronoOffset + step,
      );
    }
    refresh();
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
}

function toggleSlideshow() {
  if (state.slideshow) stopSlideshow();
  else startSlideshow();
}

function rescheduleSlideshowTick() {
  clearTimeout(state.slideshowTimer);
  if (!state.slideshow) return;
  state.slideshowTimer = setTimeout(() => {
    if (!state.slideshow) return;
    navigateForward();
  }, state.slideshowDuration);
}

document.addEventListener('visibilitychange', () => {
  if (!state.slideshow) return;
  if (document.hidden) {
    clearTimeout(state.slideshowTimer);
    state.slideshowTimer = null;
  } else {
    rescheduleSlideshowTick();
  }
});

// ==============================
// Folder loading
// ==============================
function clearDisplayFolder() {
  state.folder = null;
  state.allImages = [];
  state.displayedSlots = [];
  state.chronoOffset = 0;
  hist.stack = [];
  hist.pos = -1;
  imageGrid.textContent = '';
  folderNameEl.textContent = '';
  document.body.classList.add('no-folder');
  stopSlideshow();
  syncNavButtons();
}

async function loadFolder(folder) {
  if (!folder) return;
  try {
    const images = await window.viewerAPI.listFolderImages(folder);
    state.allImages    = images;
    state.folder       = folder;
    state.chronoOffset = 0;

    // Fresh history for the new folder
    hist.stack = [];
    hist.pos   = -1;

    folderNameEl.textContent = folder.replace(/\\/g, '/').split('/').pop();
    document.body.classList.remove('no-folder');

    refresh();
    persistSettings();
  } catch (err) {
    clearDisplayFolder();
    showToast('Failed to load folder');
    console.error(err);
  }
}

async function selectFolder() {
  const folder = await window.viewerAPI.selectFolder();
  if (folder) loadFolder(folder);
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

function applyZoomFillToImages() {
  const coverMode = isZoomFillCover(appSettings.zoomFillAmount);
  const position = coverMode ? zoomBiasPosition() : { x: 50, y: 50 };
  const positionValue = `${position.x}% ${position.y}%`;
  imageGrid.style.setProperty('--zoom-fill-x', `${position.x}%`);
  imageGrid.style.setProperty('--zoom-fill-y', `${position.y}%`);

  const curtainSide = coverMode ? null : zoomCurtainSide();
  const curtainCoverage = curtainSide ? zoomCurtainCoverage() : 0;

  imageGrid.querySelectorAll('.grid-cell').forEach(cell => {
    const img = cell.querySelector('img');
    if (img) {
      img.style.objectPosition = positionValue;
      img.style.transformOrigin = positionValue;
    }
    applyCurtainToCell(cell, img ? curtainSide : null, curtainCoverage);
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
      autoHideUiOnStartup: appSettings.autoHideUiOnStartup,
      firstDisplayFolderEnabled: appSettings.firstDisplayFolderEnabled,
      firstDisplayFolder: appSettings.firstDisplayFolder,
      secondaryDisplayFolderEnabled: appSettings.secondaryDisplayFolderEnabled,
      secondaryDisplayFolder: appSettings.secondaryDisplayFolder,
    });
  } catch { /* ignore */ }
}

async function browseStartupFolder(kind) {
  const folder = await window.viewerAPI.selectFolder();
  if (!folder) return;

  if (kind === 'first') {
    appSettings.firstDisplayFolder = folder;
  } else {
    appSettings.secondaryDisplayFolder = folder;
  }

  syncStartupFolderSettings();
  await persistSettings();
  showToast(kind === 'first' ? 'Set 1st window folder' : 'Set 2nd window folder');
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

btnFolder.addEventListener('click',    selectFolder);
btnOpenEmpty.addEventListener('click', selectFolder);

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
  await persistSettings();
});

settingSecondaryAutoOpenSlideshow.addEventListener('change', async () => {
  appSettings.secondaryAutoOpenSlideshow = settingSecondaryAutoOpenSlideshow.checked;
  await persistSettings();
});

settingAutoHideUi.addEventListener('change', async () => {
  appSettings.autoHideUiOnStartup = settingAutoHideUi.checked;
  await persistSettings();
});

settingFirstFolderEnabled.addEventListener('change', async () => {
  appSettings.firstDisplayFolderEnabled = settingFirstFolderEnabled.checked;
  syncStartupFolderSettings();
  await persistSettings();
});

settingBrowseFirstFolder.addEventListener('click', e => {
  e.stopPropagation();
  browseStartupFolder('first');
});

settingSecondaryFolderEnabled.addEventListener('change', async () => {
  appSettings.secondaryDisplayFolderEnabled = settingSecondaryFolderEnabled.checked;
  syncStartupFolderSettings();
  await persistSettings();
});

settingBrowseSecondaryFolder.addEventListener('click', e => {
  e.stopPropagation();
  browseStartupFolder('secondary');
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
document.addEventListener('click', () => setSettingsOpen(false));

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

  // Escape — unwind modals one level at a time
  if (e.key === 'Escape') {
    e.preventDefault();
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
    appSettings.autoHideUiOnStartup = !!s.autoHideUiOnStartup;
    appSettings.firstDisplayFolderEnabled = !!s.firstDisplayFolderEnabled;
    appSettings.firstDisplayFolder = s.firstDisplayFolder || null;
    appSettings.secondaryDisplayFolderEnabled = !!s.secondaryDisplayFolderEnabled;
    appSettings.secondaryDisplayFolder = s.secondaryDisplayFolder || null;

    // Sync UI without triggering refresh/persist
    countDisplayEl.textContent   = state.imageCount;
    emptyDisplayEl.textContent   = state.emptyCount;
    settingSlider.value          = state.imageCount;
    settingCountVal.textContent  = state.imageCount;
    settingSlideshowDur.value    = Math.round(state.slideshowDuration / 1000);
    settingSquareAppCorners.checked = appSettings.squareAppCorners;
    settingFirstAutoOpenSlideshow.checked = appSettings.firstAutoOpenSlideshow;
    settingSecondaryAutoOpenSlideshow.checked = appSettings.secondaryAutoOpenSlideshow;
    settingAutoHideUi.checked = appSettings.autoHideUiOnStartup;
    syncStartupFolderSettings();
    syncSlideshowButton();
    syncModeButtons();
    syncZoomFillControls();
    syncNavButtons();
    if (appSettings.autoHideUiOnStartup) {
      setUiHidden(true);
    }
    await window.viewerAPI.setWindowSquareCorners(appSettings.squareAppCorners).catch(() => {});

    const startupFolder = startupFolderForWindow();
    if (startupFolder) {
      await loadFolder(startupFolder);  // calls refresh() which calls pushHistory()
    } else {
      clearDisplayFolder();
    }
  } catch {
    syncStartupFolderSettings();
    syncSlideshowButton();
    syncModeButtons();
    syncZoomFillControls();
    syncNavButtons();
  }

  startupDone = true;
  if (shouldAutoStartSlideshow() && state.allImages.length) {
    startSlideshow();
  }
})();
