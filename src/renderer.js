'use strict';

// ==============================
// Constants
// ==============================
const HISTORY_MAX   = 50;
const UNDO_MAX      = 20;
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
// How many of the next board's images the slideshow warms ahead of the swap.
// The preload holds a decoded copy of everything it fetches, so an uncapped one
// means two full boards resident at once — harmless at the usual 16 tiles,
// measured at +438 MB on a 99-tile board of 4K images (1.57 GB -> 2.00 GB).
// Above the cap the remaining tiles simply decode as they are swapped in, which
// is what every non-slideshow board already does.
const SLIDESHOW_PRELOAD_MAX_IMAGES = 48;
const SLIDESHOW_STAGGER_BATCH_SIZE = 6;
const SLIDESHOW_STAGGER_DELAY_MS = 28;
const PORTRAIT_AUTO_BIAS_MIN_ASPECT = 1.02;
const PORTRAIT_FILL_MAX_EXTRA_SCALE = 1.08;
const PORTRAIT_FACE_SAFE_PAN = 0.78;
const PORTRAIT_BIAS_STEP_CELL_RATIO = 0.0015;
const STARTUP_WATCHDOG_INIT_MS = 15000;
const STARTUP_WATCHDOG_SCAN_MS = 20000;
const STARTUP_WATCHDOG_IMAGE_MS = 15000;
const CATEGORIZED_LARGE_LIBRARY_THRESHOLD = 2000;
// Merged cells. A merged cell is always a 2x2 block of grid positions holding ONE image —
// "one larger slot", not a family of sizes, so a merged board still reads as the same grid rather
// than a collage. Four positions in, one image slot out: a 16-position board therefore runs from
// 16 small images (no merges) to 4 large ones (4 merges), which is the whole depth/quantity dial.
const MERGE_SPAN = 2;
// Unaligned blocks (a cell straddling the middle two columns) are the interesting positions, but
// they fragment the board, so a greedy pass can come up short of the count the slider asked for.
// Retry a few times before falling back to the aligned tiling, which always reaches the maximum.
const MERGE_PLACEMENT_ATTEMPTS = 24;
// Locked cells: the image stays put while the rest of the board refreshes, and
// the image is filed into this category so it can be found later in the
// image-categorizer app (the user created this exact category name there).
const PREVIOUSLY_PINNED_CATEGORY = 'Previously pinned';
const LOCKED_IMAGES_STORAGE_KEY = 'superImageViewer.lockedImages';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ==============================
// State
// ==============================
const state = {
  folder:     null,
  allImages:  [],          // [{path, modified}] newest-first
  // 'multi' = pick folders. Every other mode browses ONE categorized root off the same scan and
  // differs only in what fills the board: the category filter, a curated country set, both blended
  // per board ('mix'), or both taking turns a whole board at a time ('alt').
  browseMode: 'multi',    // 'multi' | 'categorized' | 'geo' | 'mix' | 'alt'
  viewedBrowseMode: 'multi',
  multiFolders: [],
  multiFolderFilter: new Set(),
  categorizedRoot: null,
  categorizedCategories: [],
  categorizedCategoryFilter: new Set(),
  categorizedImages: [],

  // Curated sets from the categorized root (image-categorizer's geo layer writes them).
  // A set is an alternative POOL SOURCE, not another filter: while a set drives the pool it IS the
  // pool, and the category checkboxes stop driving anything. Mixing a curated sixteen into a
  // 17k-image category would simply dissolve it. That is exactly why geo is a separate browse
  // mode: `browseMode` being 'geo' (whole board) or 'mix' (a ratio of it) is the ONLY thing that
  // lets a set reach the grid, so a remembered country can never quietly replace the categorized
  // library it was selected alongside.
  //
  // Selection is by COUNTRY, not by individual set: `setMode` is 'off' | 'any' | 'country', and
  // each new board re-rolls which of the eligible sets is showing. `categorizedSetId` is therefore
  // a transient — the current draw — and is never persisted; the selection is. The selection also
  // survives leaving geo mode, so coming back lands on the country you left.
  categorizedSets: [],
  categorizedSetId: null,
  // Which set is actually ON THE GRID, as opposed to which one the pool was last swapped to.
  // The two diverge for as long as a board outlives the draw that produced it: arrowing back
  // replays an older country's tiles, and the slideshow rotates the pool a second early so the
  // next country's images have time to preload. Every country label reads THIS, never
  // `categorizedSetId`, or the toolbar cheerfully reads "Geo: Denmark" over a Korean board.
  displayedSetId: null,
  setMode: 'off',
  setCountry: null,
  setBag: [],                       // shuffled ids not yet drawn this cycle

  // The two "blend" modes, mix and alt. Neither merges the pools — merging is what would make a
  // curated sixteen meaningless beside a 17k-image category — they divide them with a ratio, and
  // differ only in WHAT the ratio divides:
  //   mix  — the TILES of every board: round(mixRatio%) of them come from the country set.
  //   alt  — the BOARDS: whole boards take turns, altRatio% of them geo. This is the one that
  //          shows a country set intact, which is the point of curating sixteen images.
  // `geoSidePaths` marks which members of `allImages` belong to the geo side — the only thing
  // telling the two apart once they are in one pool (which they must be, so hide/undo, replacement
  // picks, preload and the floating viewer keep working unchanged).
  mixRatio: 50,                     // percent of each board's TILES drawn from the geo set
  altRatio: 50,                     // percent of BOARDS that are geo boards
  altBoardIndex: 0,                 // which step of the alternation the current board is
  geoSidePaths: new Set(),
  // Paths vetoed as geo-set members this session. Mirrors the on-disk exclusion file so the
  // context menu can show the action as already done without re-reading it per right-click.
  geoExcludedPaths: new Set(),

  imageCount: 9,
  emptyCount: 0,
  displayMode: 'random',  // 'random' | 'chrono'
  chronoOffset: 0,        // index into allImages for chrono mode

  displayedSlots: [],     // (string|null)[] — null = intentional empty slot

  // Cell merging — a LAYER over whatever browse mode is active, not another mode. It changes the
  // SHAPE of the board, never where the images come from, so it composes with categorized / geo /
  // mix / alt instead of competing with them: some of each board's grid positions are fused into
  // 2x2 cells holding one image, trading quantity for depth without changing the board's geometry.
  // `imageCount` therefore keeps meaning grid POSITIONS; merging is what makes the number of
  // images on a board differ from it, and vary from board to board.
  mergeEnabled: false,
  mergeRatio: 50,         // propensity: each candidate 2x2 block merges with this probability
  // The board's cell geometry — {cols, rows, cells, merged, slotCount} — or null for the plain
  // one-image-per-position grid. It has to travel WITH the slots (history entries, the slideshow
  // plan, every re-render) because the slot array alone cannot say which of its entries is the
  // big one; a board replayed against a newly rolled layout would put the wrong images in the
  // wrong sizes and drop the tail of the array on the floor.
  displayedLayout: null,

  // Locked cells — Map<path, {path, index}>. A locked image keeps its slot
  // across every board refresh/shuffle/slideshow advance, persists across
  // sessions and windows (localStorage), and is filed into the "Previously
  // pinned" categorizer category. `index` is its preferred grid position.
  lockedImages: new Map(),

  slideshow:         false,
  slideshowDuration: 5000,
  slideshowTimer:    null,
  slideshowPreloadTimer: null,
  slideshowPreload: null,
  slideshowPreloadToken: 0,
  gridRenderToken: 0,

  uiHidden:     false,
  settingsOpen: false,
  shortcutsOpen: false,

  // Agent-safe mode: when on, categories in AGENT_BLOCKED_CATEGORIES can never
  // enter the shown set (see window.SIV). Off for normal human use.
  agentSafe:    false,
};

// Categories an automated agent must never be able to surface. Enforced both at
// the display layer (categorizedFilteredImages) and in the window.SIV mutators,
// so "Explicit is one flip away" is no longer true once agent-safe mode is on —
// and the SIV API refuses these regardless of the mode.
const AGENT_BLOCKED_CATEGORIES = new Set(['Explicit']);
function isAgentBlocked(name) {
  return AGENT_BLOCKED_CATEGORIES.has(name);
}

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
      if (cell) applyZoomFillToCell(cell);
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

// Reversible hide/categorize actions, most recent last. Scoped to the current
// image pool: entries restore by pool index, so loadImagePool() clears them.
const undoStack = [];

// Serializes undoLastAction() — see the comment there.
let undoChain = Promise.resolve();

// Blocks persistSettings() during the startup load
let startupDone = false;
let windowLabel = 'main';
let startupWatchdogTimer = null;
let categorizedScanSequence = 0;
let categorizedScanProgress = null;
let zoomBiasRepeatTimer = null;
let zoomBiasHoldTimer = null;
let zoomBiasRepeatPointerId = null;
const appSettings = {
  squareAppCorners: false,
  focusIndicators: true,
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
const a11yStatus         = document.getElementById('a11y-status');
const folderNameEl       = document.getElementById('folder-name');
const folderButtonLabel  = document.getElementById('folder-button-label');
const folderPanel        = document.getElementById('folder-panel');
const folderModeTabs     = document.querySelectorAll('.folder-mode-tab');
const folderLoading      = document.getElementById('folder-loading');
const folderLoadingText  = document.getElementById('folder-loading-text');
const startupLoadingText = document.getElementById('startup-loading-text');
const startupLoadingHint = document.getElementById('startup-loading-hint');
const folderSectionMulti = document.getElementById('folder-section-multi');
const folderSectionCategorized = document.getElementById('folder-section-categorized');
const folderSectionGeo   = document.getElementById('folder-section-geo');
const folderSectionBlend = document.getElementById('folder-section-blend');
const folderMultiAdd     = document.getElementById('folder-multi-add');
const multiFolderListEl  = document.getElementById('multi-folder-list');
const categorizedRootNameEl = document.getElementById('categorized-root-name');
const categorizedRootChoose = document.getElementById('categorized-root-choose');
const categoriesList     = document.getElementById('categories-list');
const categoriesSelectAll = document.getElementById('categories-select-all');
const categoriesSelectNone = document.getElementById('categories-select-none');
const categoriesRescan   = document.getElementById('categories-rescan');
const geoRootNameEl      = document.getElementById('geo-root-name');
const geoRootChoose      = document.getElementById('geo-root-choose');
const setsList           = document.getElementById('sets-list');
const setsClear          = document.getElementById('sets-clear');
const setsReload         = document.getElementById('sets-reload');
const blendRootNameEl    = document.getElementById('blend-root-name');
const blendRootChoose    = document.getElementById('blend-root-choose');
const blendHintEl        = document.getElementById('blend-hint');
const btnMerge           = document.getElementById('btn-merge');
const mergeRatioSlider   = document.getElementById('merge-ratio-slider');
const mergeRatioValue    = document.getElementById('merge-ratio-value');
const mergePanelToggle   = document.getElementById('merge-panel-toggle');
const mergePanelSlider   = document.getElementById('merge-panel-slider');
const mergePanelValue    = document.getElementById('merge-panel-value');
const mergePanelDetail   = document.getElementById('merge-panel-detail');
const blendRatioSlider   = document.getElementById('blend-ratio-slider');
const blendRatioValue    = document.getElementById('blend-ratio-value');
const blendRatioDetail   = document.getElementById('blend-ratio-detail');
const blendCategoriesList = document.getElementById('blend-categories-list');
const blendSetsList      = document.getElementById('blend-sets-list');
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
const shortcutsOverlay   = document.getElementById('shortcuts-overlay');
const shortcutsPanel     = document.getElementById('shortcuts-panel');
const shortcutsClose     = document.getElementById('shortcuts-close');
const settingSaveFirstWindow       = document.getElementById('setting-save-first-window');
const settingResetFirstWindow      = document.getElementById('setting-reset-first-window');
const settingSaveSecondaryWindow   = document.getElementById('setting-save-secondary-window');
const settingResetSecondaryWindow  = document.getElementById('setting-reset-secondary-window');
const settingSquareAppCorners      = document.getElementById('setting-square-app-corners');
const settingFocusIndicators       = document.getElementById('setting-focus-indicators');
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
let gridContextMenuReturnFocus = null;
const slideshowTimerPopover = document.getElementById('slideshow-timer-popover');
const slideshowTimerInput   = document.getElementById('slideshow-timer-input');
const slideshowTimerDec     = document.getElementById('slideshow-timer-dec');
const slideshowTimerInc     = document.getElementById('slideshow-timer-inc');
const slideshowTimerPresets = document.querySelector('.slideshow-timer-presets');
let slideshowTimerReturnFocus = null;

// ==============================
// Grid layout
// ==============================
function gridDimensions(count) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  return { cols, rows };
}

// A merged board keeps the SAME grid it would have had; only how many cells share it changes. So
// the track counts come from the layout when there is one, and from the slot count when there
// isn't — never from the number of cells, which a merged board has fewer of.
function applyGridLayout(count, layout = null) {
  const { cols, rows } = layout || gridDimensions(count);
  imageGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  imageGrid.style.gridTemplateRows    = `repeat(${rows}, 1fr)`;
}

// ==============================
// Merged cells (varying image sizes within a set)
// ==============================
// Merge is a layer over every browse mode, so all of this works off geometry alone and never
// touches the pool: which images a board draws is the browse mode's business, how big they are is
// this. See `state.mergeEnabled`.

// Fisher-Yates on a copy — the callers below all want a random ORDER, not a random pick.
function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// The grid positions a 2x2 block anchored at (col,row) covers, as row-major indices.
function blockPositions(col, row, cols) {
  const out = [];
  for (let r = row; r < row + MERGE_SPAN; r++) {
    for (let c = col; c < col + MERGE_SPAN; c++) out.push(r * cols + c);
  }
  return out;
}

// Every 2x2 block that fits inside the `count` USED positions. The grid is often wider than the
// count (13 images tile a 4x4 with three positions spare), and a block may not straddle one of
// the spares — that would hand the board a cell the count never asked for.
function mergeCandidates(cols, rows, count) {
  const out = [];
  for (let row = 0; row + MERGE_SPAN <= rows; row++) {
    for (let col = 0; col + MERGE_SPAN <= cols; col++) {
      if (blockPositions(col, row, cols).every(index => index < count)) out.push({ col, row });
    }
  }
  return out;
}

// How many merges this board gets: one Bernoulli trial per slot in the aligned tiling. That makes
// the slider a *propensity* rather than a count — at 50% on a 4x4 the board comes up anywhere from
// 0 to 4 merged cells with two typical, which is the variation the mode exists for. A fixed count
// per board would make every set the same shape, and the point is that they differ.
function drawMergeCount(maxMerges) {
  const chance = state.mergeRatio / 100;
  if (maxMerges <= 0 || chance <= 0) return 0;
  if (chance >= 1) return maxMerges;
  let count = 0;
  for (let i = 0; i < maxMerges; i++) if (Math.random() < chance) count++;
  return count;
}

// Claim up to `want` non-overlapping blocks in a random order.
function greedyBlocks(candidates, cols, want) {
  const taken = new Set();
  const blocks = [];
  for (const block of shuffled(candidates)) {
    if (blocks.length >= want) break;
    const positions = blockPositions(block.col, block.row, cols);
    if (positions.some(index => taken.has(index))) continue;
    for (const index of positions) taken.add(index);
    blocks.push(block);
  }
  return blocks;
}

// Unaligned blocks are allowed on purpose — a merged cell straddling the middle two columns is
// exactly the "randomised position" this mode is for, and restricting merges to the four quadrants
// makes every merged board look like the same four arrangements. They can fragment the grid though
// (a block in the dead centre of a 4x4 leaves no room for a second one), so a board that comes up
// short retries, and only then falls back to the aligned tiling — the one arrangement guaranteed to
// reach the maximum, which is what the top of the slider has to deliver.
function placeMergeBlocks(candidates, aligned, cols, want) {
  if (want <= 0) return [];
  for (let attempt = 0; attempt < MERGE_PLACEMENT_ATTEMPTS; attempt++) {
    const blocks = greedyBlocks(candidates, cols, want);
    if (blocks.length === want) return blocks;
  }
  return greedyBlocks(aligned, cols, want);
}

// The most merges a `count`-position board can hold: the aligned (quadrant) tiling, which is the
// densest packing of non-overlapping 2x2 blocks. Also the number of Bernoulli trials the slider
// gets, so "100%" means "as merged as this board size can be".
function maxMergesFor(count) {
  const { cols, rows } = gridDimensions(count);
  return alignedMergeCandidates(cols, rows, count).length;
}

function alignedMergeCandidates(cols, rows, count) {
  return mergeCandidates(cols, rows, count)
    .filter(block => block.col % MERGE_SPAN === 0 && block.row % MERGE_SPAN === 0);
}

// Roll this board's cell geometry. Returns null for a plain board — including when merging is on
// but the dice came up empty, since a zero-merge layout IS the default grid and saying so lets
// every downstream `if (layout)` mean "this board has a big cell in it".
function buildBoardLayout(count) {
  if (!state.mergeEnabled || state.mergeRatio <= 0 || count < MERGE_SPAN * MERGE_SPAN) return null;
  const { cols, rows } = gridDimensions(count);
  const candidates = mergeCandidates(cols, rows, count);
  const aligned = alignedMergeCandidates(cols, rows, count);
  const blocks = placeMergeBlocks(candidates, aligned, cols, drawMergeCount(aligned.length));
  if (!blocks.length) return null;

  const owner = new Map();                       // grid position -> its block
  for (const block of blocks) {
    for (const index of blockPositions(block.col, block.row, cols)) owner.set(index, block);
  }

  // Row-major walk, so the cells still read left-to-right, top-to-bottom. That order is the one
  // "Image i of n", Ctrl-drag reordering and the locked-cell indices all speak in, and a merged
  // cell takes the place of its top-left position rather than being appended at the end.
  const cells = [];
  const emitted = new Set();
  for (let index = 0; index < count; index++) {
    const block = owner.get(index);
    if (!block) {
      cells.push({ col: index % cols, row: Math.floor(index / cols), span: 1 });
      continue;
    }
    const head = block.row * cols + block.col;
    if (emitted.has(head)) continue;
    emitted.add(head);
    cells.push({ col: block.col, row: block.row, span: MERGE_SPAN });
  }
  return { cols, rows, cells, merged: blocks.length, slotCount: cells.length };
}

// grid position -> cell index, for the keyboard walk. Memoised onto the layout, which is immutable
// once rolled and is shared by reference with its history entry.
function layoutOwnerMap(layout) {
  if (layout.ownerMap) return layout.ownerMap;
  const owner = new Map();
  layout.cells.forEach((cell, index) => {
    for (let r = cell.row; r < cell.row + cell.span; r++) {
      for (let c = cell.col; c < cell.col + cell.span; c++) owner.set(r * layout.cols + c, index);
    }
  });
  layout.ownerMap = owner;
  return owner;
}

// How many image slots the NEXT board is likely to have. Merged boards vary, so this is the
// expectation, not a promise — it exists so the readouts that project a board ("N geo · M
// categorized per board of B") don't quote a board size merging has already shrunk.
function expectedSlotCount(count = state.imageCount) {
  if (!state.mergeEnabled || state.mergeRatio <= 0) return count;
  const expectedMerges = (maxMergesFor(count) * state.mergeRatio) / 100;
  return Math.max(1, Math.round(count - expectedMerges * (MERGE_SPAN * MERGE_SPAN - 1)));
}

// Image slots on the board CURRENTLY shown, which is what chrono paging has to step by.
function displayedSlotCount() {
  return state.displayedSlots.length || expectedSlotCount();
}

// ==============================
// Image selection
// ==============================
// Takes the list to draw from rather than reading `state.allImages`: mix mode picks each half of a
// board from its own side of the pool, and that is the only difference between the two.
//
// Draws by index rather than by copying the pool. The copy-and-splice version
// this replaced allocated a fresh array of EVERY image in the library on every
// board — 30k objects to choose 99 of them, on the slideshow path. Sampling by
// index is the same distribution without the copy; the fallback keeps the exact
// old behaviour for the case index sampling is bad at (a board nearly as large
// as the pool, where rejection sampling would spin).
function pickRandomFrom(images, n, exclude = null) {
  if (n <= 0 || !images.length) return [];
  const excluded = exclude ? exclude.size : 0;
  const available = images.length - excluded;
  if (n >= available / 4) {
    const pool = exclude
      ? images.filter(img => !exclude.has(img.path))
      : images.slice();
    const result = [];
    while (result.length < n && pool.length) {
      const idx = Math.floor(Math.random() * pool.length);
      result.push(pool.splice(idx, 1)[0].path);
    }
    return result;
  }

  const result = [];
  // Tracks PATHS, not indices: two pool entries can name the same file, and a
  // board must never show one image twice.
  const taken = new Set(exclude || []);
  // Bounded so a pool that is mostly excluded cannot spin here; whatever it has
  // by then is a slightly short board, not a hang.
  const maxDraws = n * 12 + 40;
  for (let draw = 0; draw < maxDraws && result.length < n; draw++) {
    const path = images[Math.floor(Math.random() * images.length)].path;
    if (taken.has(path)) continue;
    taken.add(path);
    result.push(path);
  }
  return result;
}

// `exclude` (locked images already placed) is filtered out after slicing from
// `offset`, so the chrono page start still indexes into the full timeline.
function pickChronoFrom(images, n, offset, exclude = null) {
  if (n <= 0) return [];
  let list = images.slice(Math.max(0, offset));
  if (exclude) list = list.filter(img => !exclude.has(img.path));
  return list.slice(0, n).map(img => img.path);
}

function pickRandom(n, exclude = null) {
  return pickRandomFrom(state.allImages, n, exclude);
}

function pickChrono(n, offset, exclude = null) {
  return pickChronoFrom(state.allImages, n, offset, exclude);
}

// Split `n` image slots between the two sides. This is the whole of what the two ratio sliders do
// — everything else about mix/alt is bookkeeping to keep the two pools distinguishable inside one
// `allImages`. Mix divides a board; Alt hands the whole board to one side and lets the ratio
// decide how often each side's turn comes round.
function blendSlotSplit(n, mode = state.browseMode) {
  if (mode === 'alt') {
    return altBoardIsGeo() ? { geo: n, categorized: 0 } : { geo: 0, categorized: n };
  }
  const geo = clamp(Math.round((n * state.mixRatio) / 100), 0, n);
  return { geo, categorized: n - geo };
}

// Is the board at `index` a geo board? Evenly spaced rather than random: at 50% the user asked for
// alternation, and a coin flip clumps into runs of four that read as the mode being broken. The
// modulo walk gives G,C,G,C at 50%, G,C,C,C at 25%, G,C,G,G at 75% — and starts on geo, because
// entering the mode and seeing the category library is not what picking Alt meant.
function altBoardIsGeo(index = state.altBoardIndex) {
  if (state.altRatio <= 0) return false;
  if (state.altRatio >= 100) return true;
  return ((index * state.altRatio) % 100) < state.altRatio;
}

// How many of the next `count` boards are geo — for the panel readout, which otherwise cannot say
// anything more useful than a percentage.
function altBoardPattern(count = 8) {
  return Array.from({ length: count }, (_, i) => altBoardIsGeo(state.altBoardIndex + i));
}

// The live pool, cut back into its two sides. Derived from `allImages` rather than kept alongside
// it, so an image hidden this session is gone from whichever side it was on.
function blendSubPools() {
  const geo = [];
  const categorized = [];
  for (const image of state.allImages) {
    (state.geoSidePaths.has(image.path) ? geo : categorized).push(image);
  }
  return { geo, categorized };
}

// A chrono page start indexes into `allImages`, which in these modes is both sides at once;
// applying that offset unchanged to a 16-image set would park it on its last image forever. Scale
// it into each side instead, so paging forward advances both proportionally.
function scaleChronoOffset(offset, subLength, totalLength) {
  if (!offset || subLength <= 0 || totalLength <= 0) return 0;
  return Math.min(subLength, Math.floor((offset * subLength) / totalLength));
}

// One board's worth of paths, split per `blendSlotSplit`.
//
// Mix lets a short side spill into the other, because a blended board with holes in it is just a
// worse blended board. Alt must NOT: its whole promise is that a geo board is nothing but that
// country, so a three-image set shows three images and thirteen empty cells — exactly what geo
// mode already does with a short set.
function pickBlendPaths(n, exclude, chronoOffset) {
  const { geo, categorized } = blendSubPools();
  const split = blendSlotSplit(n);
  const total = geo.length + categorized.length;
  const taken = new Set(exclude);

  const take = (images, count) => {
    const picks = state.displayMode === 'random'
      ? pickRandomFrom(images, count, taken)
      : pickChronoFrom(images, count, scaleChronoOffset(chronoOffset, images.length, total), taken);
    for (const path of picks) taken.add(path);
    return picks;
  };

  if (state.browseMode === 'alt') {
    return take(split.geo ? geo : categorized, n);
  }

  const geoPicks = take(geo, split.geo);
  const catPicks = take(categorized, split.categorized + (split.geo - geoPicks.length));
  const shortfall = n - geoPicks.length - catPicks.length;
  const spill = shortfall > 0 ? take(geo, shortfall) : [];
  return [...geoPicks, ...catPicks, ...spill];
}

// Build a board: a slot array (image paths + null empty slots, all shuffled together) and the cell
// geometry it was built for. Locked images are reserved at their saved positions first, kept out
// of the random/chrono pick so they never appear twice, and everything else fills in around them —
// so a refresh reshuffles the board but never a locked cell.
//
// Returns the layout alongside the slots rather than stashing it, because the two are one board:
// the slot count is DERIVED from the layout (each merged cell swallows four grid positions and
// gives back one slot), so a caller holding one without the other holds a board it cannot render.
function generateSlots(chronoOffset = state.chronoOffset) {
  const layout   = buildBoardLayout(state.imageCount);
  const total    = layout ? layout.slotCount : state.imageCount;
  const reserved = lockedReservations(total);     // Map<index, path>
  const lockedPaths  = new Set(reserved.values());
  const lockedCount  = reserved.size;

  let empties = Math.min(state.emptyCount, total - 1);
  empties     = Math.min(empties, Math.max(0, total - lockedCount));
  const imgN      = total - empties;
  const freshImgN = Math.max(0, imgN - lockedCount);

  const paths = usesBlendPool()
    ? pickBlendPaths(freshImgN, lockedPaths, chronoOffset)
    : state.displayMode === 'random'
      ? pickRandom(freshImgN, lockedPaths)
      : pickChrono(freshImgN, chronoOffset, lockedPaths);

  // Non-locked slot contents: fresh images, padding nulls, and empty slots,
  // shuffled together — then poured into the positions locks didn't claim.
  const nonLocked = [
    ...paths,
    ...Array(Math.max(0, freshImgN - paths.length)).fill(null),
    ...Array(empties).fill(null),
  ];
  for (let i = nonLocked.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nonLocked[i], nonLocked[j]] = [nonLocked[j], nonLocked[i]];
  }

  const slots = new Array(total).fill(undefined);
  for (const [index, path] of reserved) {
    if (index >= 0 && index < total) slots[index] = path;
  }
  let k = 0;
  for (let i = 0; i < total; i++) {
    if (slots[i] === undefined) slots[i] = k < nonLocked.length ? nonLocked[k++] : null;
  }
  return { slots, layout };
}

// ==============================
// History
// ==============================
function pushHistory(slots, chronoOffset) {
  hist.stack.splice(hist.pos + 1);                 // discard forward entries
  // Stamp the geo set these slots were drawn from. A board is a snapshot of one country, so the
  // country belongs to the history entry — not to a mutable "current draw" that has already moved
  // on by the time you arrow back to it.
  const setId = boardSetId();
  // The cell geometry is stamped too, and read from `state.displayedLayout` rather than passed:
  // every caller has already installed the layout these slots belong to (a shuffle and a
  // history-head resync deliberately keep the board's shape while its contents move). Replaying an
  // entry against a freshly rolled layout would resize the wrong tiles and drop the array's tail.
  hist.stack.push({ slots: [...slots], chronoOffset, setId, layout: state.displayedLayout });
  if (hist.stack.length > HISTORY_MAX) hist.stack.shift();
  hist.pos = hist.stack.length - 1;
  setDisplayedSet(setId);
  syncNavButtons();
}

// The set the board being pushed is actually made of. In alt, every other board is a CATEGORY
// board that happens to have a country set loaded beside it — stamping that set would put a
// country name over a board with none of its images on it.
function boardSetId() {
  if (state.browseMode === 'alt' && !altBoardIsGeo()) return null;
  return state.categorizedSetId;
}

function restoreEntry(entry, options = {}) {
  // Overlay locks onto a copy so a locked cell never changes even when an older
  // set is replayed; the stored history entry itself is left untouched.
  state.displayedSlots = overlayLocks([...entry.slots]);
  state.displayedLayout = entry.layout || null;
  state.chronoOffset   = entry.chronoOffset;
  // Replaying an older board puts an older country back on screen; the labels must follow it back.
  setDisplayedSet(entry.setId ?? null);
  renderGrid(state.displayedSlots, options);
}

// Point every country-facing label at `setId` and repaint them. One place, because the folder
// button, the pool header and the "showing" mark in the sets panel must never disagree about
// which country the grid is displaying.
function setDisplayedSet(setId) {
  if (state.displayedSetId === setId) return;
  state.displayedSetId = setId;
  syncDisplayedSetLabels();
}

function syncDisplayedSetLabels() {
  renderFolderButton();
  if (usesGeoSets()) folderNameEl.textContent = categorizedPoolLabel();
  renderSetsPanel();
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
  if (!appSettings.startupCategorizedRoot) return 'No categorized root set';
  const root = baseName(appSettings.startupCategorizedRoot);
  if (appSettings.startupBrowseMode === 'geo') return `${root} · geo`;
  if (usesBlendPool(appSettings.startupBrowseMode)) {
    const mode = appSettings.startupBrowseMode;
    return `${root} · ${mode} ${blendRatio(mode)}% geo`;
  }
  return root;
}

function syncStartupSourceSettings() {
  settingStartupBrowseMode.value = appSettings.startupBrowseMode;
  settingStartupSourceName.textContent = startupSourceLabel();
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

async function loadAutoSlideshowCategorizedSource(mode) {
  const root = appSettings.startupCategorizedRoot || state.categorizedRoot;
  if (appSettings.startupCategorizedRoot) {
    state.categorizedRoot = appSettings.startupCategorizedRoot;
    state.categorizedCategoryFilter = new Set(appSettings.startupCategorizedCategoryFilter);
  }
  state.viewedBrowseMode = mode;
  renderCategorizedRootRow();
  renderFolderPanelSections();
  await enterCategorizedMode(root, { eager: mode === 'categorized', targetMode: mode });
  if (state.browseMode !== mode) {
    loadImagePool([], root ? baseName(root) : 'No categorized root', mode);
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

  const mode = appSettings.startupBrowseMode;
  state.categorizedRoot = appSettings.startupCategorizedRoot;
  state.categorizedCategoryFilter = new Set(appSettings.startupCategorizedCategoryFilter);
  state.viewedBrowseMode = mode;
  renderCategorizedRootRow();
  renderFolderPanelSections();
  await enterCategorizedMode(undefined, { eager: mode === 'categorized', targetMode: mode });
}

async function loadAutoSlideshowSource() {
  if (['categorized', 'geo', 'mix', 'alt'].includes(appSettings.autoSlideshowSource)) {
    await loadAutoSlideshowCategorizedSource(appSettings.autoSlideshowSource);
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
// Locked cells
// ==============================
function isLocked(path) {
  return !!path && state.lockedImages.has(path);
}

function loadLockedImages() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCKED_IMAGES_STORAGE_KEY) || '[]');
    state.lockedImages = new Map();
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (entry && typeof entry.path === 'string') {
          const index = Number.isInteger(entry.index) ? entry.index : null;
          state.lockedImages.set(entry.path, { path: entry.path, index });
        }
      }
    }
  } catch {
    state.lockedImages = new Map();
  }
}

function persistLockedImages() {
  try {
    const list = [...state.lockedImages.values()].map(lock => ({ path: lock.path, index: lock.index }));
    localStorage.setItem(LOCKED_IMAGES_STORAGE_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
}

// Which grid positions locked images should occupy for a `total`-slot board.
// Only locks whose image is in the current pool are placed; each keeps its
// saved slot when free, and any that collide (or have no saved slot) drop into
// the next open position. Returns Map<index, path>.
function lockedReservations(total) {
  const byIndex = new Map();
  if (!state.lockedImages.size || total <= 0) return byIndex;
  const poolPaths = new Set(state.allImages.map(img => img.path));
  const used = new Set();
  const pending = [];
  for (const lock of state.lockedImages.values()) {
    if (!poolPaths.has(lock.path)) continue;
    const idx = lock.index;
    if (Number.isInteger(idx) && idx >= 0 && idx < total && !used.has(idx)) {
      byIndex.set(idx, lock.path);
      used.add(idx);
    } else {
      pending.push(lock.path);
    }
  }
  let free = 0;
  for (const path of pending) {
    while (free < total && used.has(free)) free++;
    if (free >= total) break;
    byIndex.set(free, path);
    used.add(free);
  }
  return byIndex;
}

// Force locked images onto an already-built slot array (history replay), so a
// locked cell shows its pinned image no matter which past set is restored.
// Mutates and returns the passed array.
function overlayLocks(slots) {
  if (!state.lockedImages.size || !slots.length) return slots;
  const reserved = lockedReservations(slots.length);
  if (!reserved.size) return slots;
  const lockedPaths = new Set(reserved.values());
  for (let i = 0; i < slots.length; i++) {
    if (lockedPaths.has(slots[i]) && reserved.get(i) !== slots[i]) slots[i] = null;
  }
  for (const [index, path] of reserved) {
    if (index >= 0 && index < slots.length) slots[index] = path;
  }
  return slots;
}

// Toggle the `.locked` decoration on every occupied cell to match current
// lock state — used after a lock/unlock that doesn't rebuild the grid.
function refreshLockedCellDecorations() {
  imageGrid.querySelectorAll('.grid-cell').forEach(cell => {
    if (cell.classList.contains('empty-slot')) {
      cell.classList.remove('locked');
      return;
    }
    const img = cell.querySelector('img');
    const path = img && img.getAttribute('data-src');
    cell.classList.toggle('locked', isLocked(path));
  });
}

// File a pinned image into the "Previously pinned" category so it can be found
// later in the image-categorizer app. Uses the active categorized root when
// browsing one; otherwise locates the nearest categorizer sidecar above the
// file. Silently no-ops when the image isn't inside any categorizer library.
async function filePreviouslyPinned(path) {
  try {
    let root = null;
    if (usesCategorizedRoot() && state.categorizedRoot) {
      root = state.categorizedRoot;
    } else if (window.viewerAPI.findCategorizerRoot) {
      root = await window.viewerAPI.findCategorizerRoot(path).catch(() => null);
    }
    if (!root) return false;
    await window.viewerAPI.setImageCategory(root, path, PREVIOUSLY_PINNED_CATEGORY);
    // Keep the category panel/counts current when it's the root we're browsing.
    if (usesCategorizedRoot() && state.categorizedRoot === root) {
      applyLocalCategoryChange(path, PREVIOUSLY_PINNED_CATEGORY);
    }
    return true;
  } catch (error) {
    console.error('Failed to file image into Previously pinned:', error);
    return false;
  }
}

function lockImage(path) {
  if (!path || isLocked(path)) return;
  const index = state.displayedSlots.indexOf(path);
  state.lockedImages.set(path, { path, index: index >= 0 ? index : null });
  persistLockedImages();
  refreshLockedCellDecorations();
  // The warmed-up next slideshow set was planned without this lock.
  clearSlideshowPreload();
  if (state.slideshow) scheduleSlideshowPreload();
  filePreviouslyPinned(path).then(filed => {
    showToast(filed ? `Locked · filed under “${PREVIOUSLY_PINNED_CATEGORY}”` : 'Locked');
  });
}

// Unlocking only lifts the pin — the image stays in the "Previously pinned"
// category on disk (that's the point: find it there after unlocking).
function unlockImage(path) {
  if (!isLocked(path)) return;
  state.lockedImages.delete(path);
  persistLockedImages();
  refreshLockedCellDecorations();
  clearSlideshowPreload();
  if (state.slideshow) scheduleSlideshowPreload();
  showToast('Unlocked');
}

function toggleLock(path) {
  if (isLocked(path)) unlockImage(path);
  else lockImage(path);
}

// ==============================
// Render grid
// ==============================
function applyImageSlot(img, slot, position = null) {
  if (img.getAttribute('data-src') === slot) return;
  clearImageManualZoom(img);
  img.setAttribute('data-src', slot);
  img.removeAttribute('data-pending-src');
  img.removeAttribute('title');
  const cell = img.closest('.grid-cell');
  setCellAccessibility(cell, slot, position);
  img.classList.remove('loaded');
  img.onload  = () => {
    img.classList.add('loaded');
    const loadedCell = img.closest('.grid-cell');
    if (loadedCell) applyZoomFillToCell(loadedCell);
  };
  // A file that won't decode is not a tile that should sit there blank. The
  // path is captured rather than re-read off the element: by the time the error
  // fires the cell may already hold something else, and it is THIS image that
  // is unusable.
  img.onerror = () => noteImageLoadFailure(slot);
  img.src = window.viewerAPI.getFileUrl(slot);
}

// ------------------------------------------------------------------
// Unloadable images
// ------------------------------------------------------------------
// An image can be listed by the scan and still be impossible to show: deleted
// or renamed since the scan, zero bytes, truncated, or simply not a real image
// behind an image extension. Nothing used to happen — the cell stayed blank,
// the path stayed in the pool, and every later board could draw it again. So a
// folder with a few bad files showed permanent holes in the grid.
//
// A failure therefore retires the path for the session: out of the pool, out of
// history, unlocked if it was pinned, and its slot refilled from the pool.
// Failures are batched to the next frame because a board of 99 tiles can fail
// dozens at once, and each one re-renders the grid.
const failedImagePaths = new Set();
const pendingImageFailures = new Set();
let imageFailureFlush = null;

// Scoped to the pool, not to the session. A rescan has just seen these files on
// disk, so it earns them one fresh attempt each — and keeping the old set would
// be worse than useless: the "already known bad" short-circuit below would skip
// retiring them from the NEW pool, putting the permanently blank tile back.
function resetImageFailures() {
  if (imageFailureFlush !== null) cancelAnimationFrame(imageFailureFlush);
  imageFailureFlush = null;
  failedImagePaths.clear();
  pendingImageFailures.clear();
}

function noteImageLoadFailure(path) {
  if (!path || failedImagePaths.has(path)) return;
  failedImagePaths.add(path);
  pendingImageFailures.add(path);
  if (imageFailureFlush !== null) return;
  imageFailureFlush = requestAnimationFrame(flushImageLoadFailures);
}

function flushImageLoadFailures() {
  imageFailureFlush = null;
  const dropped = new Set(pendingImageFailures);
  pendingImageFailures.clear();
  if (!dropped.size) return;

  const poolBefore = state.allImages.length;
  state.allImages = state.allImages.filter(image => !dropped.has(image.path));
  for (const path of dropped) {
    purgeFromHistory(path);
    // A pinned image that no longer exists would otherwise reserve its cell on
    // every future board — the one way a dead file can outlive this cleanup.
    if (isLocked(path)) unlockImage(path);
  }
  clearSlideshowPreload();

  const shown = new Set(state.displayedSlots.filter(Boolean));
  let changed = false;
  state.displayedSlots.forEach((slot, index) => {
    if (!dropped.has(slot)) return;
    shown.delete(slot);
    const replacement = pickReplacementImage(shown);
    if (replacement) shown.add(replacement);
    state.displayedSlots[index] = replacement;
    changed = true;
  });

  if (changed) {
    renderGrid(state.displayedSlots);
    syncHistoryHead();
    if (state.slideshow) rescheduleSlideshowTick();
  }
  if (poolBefore && !state.allImages.length) {
    document.body.classList.add('no-folder');
    state.displayedSlots = [];
    clearGridCells();
    syncNavButtons();
  }
  console.warn(`Dropped ${dropped.size} unreadable image(s) from the pool`, [...dropped]);
}

// Empty the grid, releasing the per-image manual pan/zoom bookkeeping first.
// Dropping the elements without this leaks `manualZoomActiveCount`, and that
// counter is what tells every later zoom pass whether it can skip the manual
// override work for every cell.
function clearGridCells() {
  for (const img of imageGrid.querySelectorAll('img')) deleteImageManualZoom(img);
  imageGrid.textContent = '';
  state.displayedLayout = null;
  hoveredCell = null;
  lastManualZoomCell = null;
}

function renderGrid(slots, options = {}) {
  // Menu actions capture the image path present when the menu opens. Any grid
  // render can replace that image, so dismiss the menu before changing cells.
  closeGridContextMenu({ restoreFocus: true });
  const stagger = !!options.stagger && !prefersReducedMotion();
  const renderToken = ++state.gridRenderToken;
  const layout = state.displayedLayout && state.displayedLayout.cells.length === slots.length
    ? state.displayedLayout
    : null;
  applyGridLayout(slots.length || state.imageCount, layout);

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

    const placement = layout ? layout.cells[i] : null;
    applyCellPlacement(cell, placement);

    // Where this tile sits, for its accessible name. Passed down rather than
    // recomputed per cell: working it out from the DOM means a querySelectorAll
    // + indexOf inside a loop that already knows the answer, which is O(n²) over
    // the board — 99 tiles was 9,801 cell visits per render.
    const position = { index: i, total: slots.length, span: placement ? placement.span : 1 };

    if (slot === null) {
      cell.classList.add('empty-slot');
      cell.classList.remove('locked');
      setCellAccessibility(cell, null, position);
      const img = cell.querySelector('img');
      if (img) {
        clearImageManualZoom(img);
        img.remove();
      }
    } else {
      cell.classList.remove('empty-slot');
      cell.classList.toggle('locked', isLocked(slot));
      let img = cell.querySelector('img');
      if (!img) {
        img = document.createElement('img');
        img.draggable = false;
        img.alt = '';
        cell.appendChild(img);
      }
      if (img.getAttribute('data-src') !== slot) {
        if (stagger) {
          img.setAttribute('data-pending-src', slot);
          pendingImageUpdates.push({ img, slot, position });
        }
        else applyImageSlot(img, slot, position);
      } else {
        img.removeAttribute('data-pending-src');
        setCellAccessibility(cell, slot, position);
      }
    }
  });
  applyZoomFillToImages();
  enrichAccessibleOcr();

  if (!pendingImageUpdates.length) return;

  pendingImageUpdates.forEach((update, index) => {
    const batch = Math.floor(index / SLIDESHOW_STAGGER_BATCH_SIZE);
    window.setTimeout(() => {
      if (renderToken !== state.gridRenderToken) return;
      applyImageSlot(update.img, update.slot, update.position);
    }, batch * SLIDESHOW_STAGGER_DELAY_MS);
  });
}

// A merged board places EVERY cell explicitly. Auto-placement cannot be trusted once one cell
// spans 2x2: it flows the rest around the span and leaves holes the slot array knows nothing
// about, so cell i and slot i stop describing the same tile. Plain boards clear the properties
// back out and go on flowing, since a cell element is reused across renders.
function applyCellPlacement(cell, placement) {
  if (!placement) {
    if (cell.style.gridColumn) cell.style.gridColumn = '';
    if (cell.style.gridRow) cell.style.gridRow = '';
    cell.classList.remove('merged-cell');
    return;
  }
  cell.style.gridColumn = `${placement.col + 1} / span ${placement.span}`;
  cell.style.gridRow    = `${placement.row + 1} / span ${placement.span}`;
  cell.classList.toggle('merged-cell', placement.span > 1);
}

function setCellAccessibility(cell, path, position = null) {
  if (!cell) return;
  const button = cell.querySelector('.grid-cell-accessibility');
  if (!button) return;
  if (path) {
    button.setAttribute('aria-label', accessibleImageName(cell, path, position));
    button.disabled = false;
    button.hidden = false;
  } else {
    button.hidden = true;
    button.disabled = true;
    button.removeAttribute('aria-label');
  }
}

// The accessible name for an image tile. This is the ONLY text a screen reader
// (or an agent reading the DOM / an aria snapshot) gets for the image, so make
// it describe the picture, not just its filename: grid position, its category,
// its OCR text snippet when known, then the filename as a stable handle. OCR is
// filled in asynchronously by enrichAccessibleOcr(); until it arrives the name
// still carries position + category + filename.
// `position` ({index, total}) is supplied by every caller that is already
// walking the grid; only the one-off callers pay for looking it up.
function accessibleImageName(cell, path, position = null) {
  let index = position ? position.index : -1;
  let total = position ? position.total : 0;
  if (!position) {
    const cells = [...imageGrid.querySelectorAll('.grid-cell')];
    index = cells.indexOf(cell);
    total = cells.length;
  }
  // A merged cell is four positions of board given to one image, and that is a visible fact about
  // the tile — so it belongs in the name a screen reader (or an agent) gets, not only in the CSS.
  const span = position
    ? (position.span || 1)
    : (cell && cell.classList.contains('merged-cell') ? MERGE_SPAN : 1);
  const parts = [];
  if (index >= 0 && total) parts.push(`Image ${index + 1} of ${total}`);
  if (span > 1) parts.push('large');
  const category = usesCategorizedRoot() ? categoryForPath(path) : null;
  if (category) parts.push(category);
  const ocr = ocrTextCache.get(path);
  if (ocr) parts.push(`“${ocr}”`);
  parts.push(baseName(path));
  return parts.join(' — ');
}

// OCR snippet per image path. '' is a real cached value meaning "fetched, none",
// so we never re-request it. Keyed by the same path strings the grid uses.
const ocrTextCache = new Map();
let ocrFetchToken = 0;

// Re-apply accessible names to every occupied cell (e.g. after OCR arrives).
function refreshAccessibleNames() {
  const cells = [...imageGrid.querySelectorAll('.grid-cell')];
  cells.forEach((cell, index) => {
    if (cell.classList.contains('empty-slot')) return;
    const img = cell.querySelector('img');
    const path = img && img.getAttribute('data-src');
    if (path) setCellAccessibility(cell, path, { index, total: cells.length, span: cellSpan(cell) });
  });
}

function cellSpan(cell) {
  return cell && cell.classList.contains('merged-cell') ? MERGE_SPAN : 1;
}

// 2D roving focus between grid tiles. On a plain board, columns mirror applyGridLayout's
// ceil(sqrt(n)) and a fixed stride is enough; a merged board has no such stride and goes through
// moveGridFocusInLayout. Either way focus lands on the next occupied cell's keyboard button.
function moveGridFocus(fromCell, key) {
  const cells = [...imageGrid.querySelectorAll('.grid-cell')];
  const from = cells.indexOf(fromCell);
  if (from < 0) return;
  const layout = state.displayedLayout;
  if (layout && layout.cells.length === cells.length) {
    moveGridFocusInLayout(cells, layout, from, key);
    return;
  }
  const cols = Math.max(1, Math.ceil(Math.sqrt(cells.length)));
  const delta = key === 'ArrowRight' ? 1
    : key === 'ArrowLeft' ? -1
    : key === 'ArrowDown' ? cols
    : -cols;
  // Step in that direction to the first cell with a usable keyboard button,
  // so empty slots are skipped rather than trapping focus.
  for (let target = from + delta; target >= 0 && target < cells.length; target += delta) {
    const btn = cells[target].querySelector('.grid-cell-accessibility');
    if (btn && !btn.hidden && !btn.disabled) { btn.focus(); return; }
  }
}

// The same roving over a merged board, where there is no uniform stride to add: a 2x2 cell's
// right-hand neighbour is one column past its RIGHT edge, and a cell two rows tall is the same
// neighbour from either of the rows beside it. So walk grid positions from the block's leading
// edge and take the first different cell that can hold focus.
function moveGridFocusInLayout(cells, layout, from, key) {
  const owner = layoutOwnerMap(layout);
  const cell = layout.cells[from];
  const step = key === 'ArrowRight' ? { x: 1, y: 0 }
    : key === 'ArrowLeft' ? { x: -1, y: 0 }
    : key === 'ArrowDown' ? { x: 0, y: 1 }
    : { x: 0, y: -1 };
  let col = step.x > 0 ? cell.col + cell.span - 1 : cell.col;
  let row = step.y > 0 ? cell.row + cell.span - 1 : cell.row;

  for (let guard = layout.cols * layout.rows; guard > 0; guard--) {
    col += step.x;
    row += step.y;
    if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) return;
    const target = owner.get(row * layout.cols + col);
    if (target === undefined || target === from) continue;
    const btn = cells[target].querySelector('.grid-cell-accessibility');
    // Empty slots are skipped rather than trapping focus, exactly as on a plain board.
    if (btn && !btn.hidden && !btn.disabled) { btn.focus(); return; }
  }
}

// Fetch OCR text for the currently displayed categorized images and refresh
// their names. Cheap: only the ~16 shown tiles, only the ones not already
// cached. No-op unless a categorized root is being browsed (categorized or geo).
async function enrichAccessibleOcr() {
  if (!usesCategorizedRoot() || !state.categorizedRoot) return;
  if (!window.viewerAPI || !window.viewerAPI.getCategorizedOcr) return;
  const missing = state.displayedSlots.filter(p => p && !ocrTextCache.has(p));
  if (!missing.length) return;
  const token = ++ocrFetchToken;
  let results;
  try {
    results = await window.viewerAPI.getCategorizedOcr(state.categorizedRoot, missing) || [];
  } catch { return; }
  for (const r of results) ocrTextCache.set(r.path, r.text);
  for (const p of missing) if (!ocrTextCache.has(p)) ocrTextCache.set(p, ''); // negative cache
  if (token !== ocrFetchToken) return; // superseded by a newer fetch
  refreshAccessibleNames();
}

// ==============================
// Tile reordering (Ctrl-drag)
// ==============================
// Ctrl/Cmd + drag picks up a tile and drops it on another to swap their grid
// positions; plain drag still pans within the cell. A locked tile reorders like
// any other — when it lands, its lock remembers the new slot, so the new
// position also sticks through later refreshes.
let reorderGhostEl = null;
let reorderTargetCell = null;

function cellUnderPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  const cell = el && el.closest ? el.closest('.grid-cell') : null;
  return cell && imageGrid.contains(cell) ? cell : null;
}

function cellIndex(cell) {
  return cell ? [...imageGrid.querySelectorAll('.grid-cell')].indexOf(cell) : -1;
}

function setReorderTargetCell(cell) {
  if (reorderTargetCell === cell) return;
  if (reorderTargetCell) reorderTargetCell.classList.remove('reorder-target');
  reorderTargetCell = cell || null;
  if (reorderTargetCell) reorderTargetCell.classList.add('reorder-target');
}

function createReorderGhost(sourceCell) {
  removeReorderGhost();
  const img = sourceCell.querySelector('img');
  if (!img) return;
  const ghost = document.createElement('div');
  ghost.className = 'reorder-ghost';
  const clone = document.createElement('img');
  clone.src = img.currentSrc || img.src;
  clone.alt = '';
  clone.draggable = false;
  ghost.appendChild(clone);
  document.body.appendChild(ghost);
  reorderGhostEl = ghost;
}

function moveReorderGhost(x, y) {
  if (!reorderGhostEl) return;
  reorderGhostEl.style.left = `${x}px`;
  reorderGhostEl.style.top = `${y}px`;
}

function removeReorderGhost() {
  if (reorderGhostEl) {
    reorderGhostEl.remove();
    reorderGhostEl = null;
  }
}

function endReorderVisuals(sourceCell) {
  if (sourceCell) sourceCell.classList.remove('reorder-source');
  setReorderTargetCell(null);
  removeReorderGhost();
}

// If the image now sitting at `index` is locked, repin the lock to it so the
// hand-placed position survives future board refreshes. Returns whether it
// changed anything.
function restickLockAt(index) {
  const path = state.displayedSlots[index];
  if (path && state.lockedImages.has(path)) {
    state.lockedImages.set(path, { path, index });
    return true;
  }
  return false;
}

function commitReorder(sourceCell, targetCell) {
  const from = cellIndex(sourceCell);
  const to = cellIndex(targetCell);
  const slots = state.displayedSlots;
  if (from === -1 || to === -1 || from === to) return;
  if (from >= slots.length || to >= slots.length) return;
  [slots[from], slots[to]] = [slots[to], slots[from]];
  let lockChanged = restickLockAt(from);
  lockChanged = restickLockAt(to) || lockChanged;
  if (lockChanged) persistLockedImages();
  renderGrid(slots);
  syncHistoryHead();               // keep the current set's history entry in sync
  if (state.slideshow) rescheduleSlideshowTick();
}

// Wires per-cell drag-to-pan / wheel-to-zoom / click-to-open-floating-view.
// Attached once per .grid-cell element (cells are reused across renders), so
// it always looks up the current <img> inside the cell at interaction time.
function attachCellInteractions(cell) {
  let drag = null;
  let reorder = null;

  // This transparent, keyboard-only button leaves all pointer interaction on
  // the cell unchanged while giving each occupied image a proper accessible
  // name and standard Enter/Space activation behavior.
  const accessibilityButton = document.createElement('button');
  accessibilityButton.type = 'button';
  accessibilityButton.className = 'grid-cell-accessibility';
  accessibilityButton.hidden = true;
  accessibilityButton.disabled = true;
  cell.appendChild(accessibilityButton);

  function openKeyboardContextMenu() {
    const img = cell.querySelector('img');
    const path = img && img.getAttribute('data-src');
    if (!path) return;
    const rect = cell.getBoundingClientRect();
    openImageContextMenu(path, rect.left + 16, rect.top + 16, {
      focusMenu: true,
      returnFocus: accessibilityButton,
    });
  }

  accessibilityButton.addEventListener('click', () => openFloatingImage(cell));
  accessibilityButton.addEventListener('keydown', e => {
    // Stop the app-wide Space shortcut; native button behavior will activate
    // this image on Space or Enter.
    if (e.key === ' ' || e.key === 'Enter') {
      e.stopPropagation();
      return;
    }
    // Arrow keys move focus tile-to-tile (2D). Stop propagation so the global
    // ←/→ "previous/next set" shortcut doesn't also fire while a tile is focused.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      moveGridFocus(cell, e.key);
      return;
    }
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
    e.preventDefault();
    e.stopPropagation();
    openKeyboardContextMenu();
  });
  accessibilityButton.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    // Some webviews dispatch both the key event and a synthetic contextmenu
    // event for Shift+F10. Do not let the second event toggle the menu closed.
    if (!gridContextMenu.classList.contains('open')) openKeyboardContextMenu();
  });

  cell.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    // A left-click while the categorize menu is open just dismisses it —
    // don't start a drag or open the floating image on that same click.
    if (gridContextMenu.classList.contains('open')) {
      closeGridContextMenu();
      return;
    }
    const img = cell.querySelector('img');

    // Ctrl/Cmd + drag reorders tiles (swap positions) instead of panning the
    // image within its cell.
    if (e.ctrlKey || e.metaKey) {
      if (!img || !img.getAttribute('data-src') || cell.classList.contains('empty-slot')) return;
      reorder = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false };
      try { cell.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
      return;
    }

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
    if (reorder && e.pointerId === reorder.pointerId) {
      const rdx = e.clientX - reorder.startX;
      const rdy = e.clientY - reorder.startY;
      if (!reorder.active) {
        if (Math.hypot(rdx, rdy) < MANUAL_DRAG_THRESHOLD_PX) return;
        reorder.active = true;
        cell.classList.add('reorder-source');
        createReorderGhost(cell);
      }
      deferSlideshowTick();
      moveReorderGhost(e.clientX, e.clientY);
      const over = cellUnderPoint(e.clientX, e.clientY);
      setReorderTargetCell(over && over !== cell ? over : null);
      return;
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.dragging) {
      if (Math.hypot(dx, dy) < MANUAL_DRAG_THRESHOLD_PX) return;
      drag.dragging = true;
      lastManualZoomCell = cell;
      cell.classList.add('panning');
    }
    deferSlideshowTick();

    const rect = cell.getBoundingClientRect();
    const totalScale = zoomFillScale(appSettings.zoomFillAmount) * drag.baseline.scale;
    const { maxTx, maxTy } = manualZoomOverflow(drag.img, rect, totalScale);
    setImageManualZoom(drag.img, {
      scale: drag.baseline.scale,
      tx: clamp(drag.baseline.tx + dx, -maxTx, maxTx),
      ty: clamp(drag.baseline.ty + dy, -maxTy, maxTy),
    });
    applyZoomFillToCell(cell);
  });

  function endDrag(e) {
    if (reorder && e.pointerId === reorder.pointerId) {
      try { cell.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      const wasActive = reorder.active;
      const dropCell = cellUnderPoint(e.clientX, e.clientY);
      endReorderVisuals(cell);
      reorder = null;
      if (wasActive && dropCell && dropCell !== cell) commitReorder(cell, dropCell);
      return;
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    const wasDragging = drag.dragging;
    try { cell.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    cell.classList.remove('panning');
    drag = null;
    if (!wasDragging) openFloatingImage(cell);
  }
  cell.addEventListener('pointerup', endDrag);
  cell.addEventListener('pointercancel', e => {
    if (reorder && e.pointerId === reorder.pointerId) {
      endReorderVisuals(cell);
      reorder = null;
    }
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
    applyZoomFillToCell(cell);
    deferSlideshowTick();
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
  // Step by the board actually on screen, not by `imageCount`: merging makes those differ, and a
  // page step that assumed the unmerged size would skip past images nobody ever saw. Merged boards
  // vary, so this is the best available answer rather than an exact one — it can only overlap or
  // page short by a tile or two, never leave a gap.
  const step = Math.max(1, displayedSlotCount() - state.emptyCount);
  const next = state.chronoOffset + step;
  // `next` is a page start, not an image index. Clamping it to the last index
  // (as this used to) let it settle mid-page, where the page degraded to a
  // single image and then never moved again — every later advance re-pushed
  // that same set until it had evicted all real history. Past the last page,
  // wrap to the newest instead: chrono is the only mode that can run out, and
  // a slideshow that loops beats one that freezes.
  return next >= state.allImages.length ? 0 : next;
}

function buildNextSlideshowPlan() {
  if (hist.pos < hist.stack.length - 1) {
    const entry = hist.stack[hist.pos + 1];
    return {
      slots: overlayLocks([...entry.slots]),
      layout: entry.layout || null,
      chronoOffset: entry.chronoOffset,
      fromHistory: true,
    };
  }

  const chronoOffset = nextChronoOffset();
  const board = generateSlots(chronoOffset);
  return {
    slots: board.slots,
    // Rolled here, a whole preload ahead of the swap, and carried to the swap with its slots — the
    // board's shape is decided when its images are picked, not when they appear.
    layout: board.layout,
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

  // Rotate before planning, not when the plan is applied: the plan preloads the images it picked,
  // so the swap has to happen while there is still time to fetch the next country's tiles. Skipped
  // when the next step replays an existing history entry, which has its own images already.
  if (hist.pos >= hist.stack.length - 1) rotateSetIfActive();

  const token = ++state.slideshowPreloadToken;
  const plan = buildNextSlideshowPlan();
  const keepAlive = [];
  const paths = [...new Set(plan.slots.filter(Boolean))].slice(0, SLIDESHOW_PRELOAD_MAX_IMAGES);

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
  // Only an explicit "new board" rotates the country — a refresh caused by changing the image
  // count or the zoom must not teleport you somewhere else.
  if (options.rotate) rotateSetIfActive();
  if (!state.allImages.length) return;
  const { slots, layout } = generateSlots();
  state.displayedSlots = slots;
  state.displayedLayout = layout;
  renderGrid(slots, options);
  pushHistory(slots, state.chronoOffset);
  rescheduleSlideshowTick();
  // Slideshow advances silently; an explicit new set is announced.
  if (!state.slideshow) announce(`New set — ${slots.filter(Boolean).length} images`);
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
  if (!state.slideshow) announce(`Previous set${navSetSuffix()}`);
}

// The country an arrow landed on, for the live region. Only where a set is showing.
function navSetSuffix() {
  if (!usesGeoSets()) return '';
  const set = displayedCategorizedSet();
  return set ? ` — ${set.country || set.title}` : '';
}

function navigateForward() {
  if (hist.pos < hist.stack.length - 1) {
    // Re-play a set from history
    hist.pos++;
    restoreEntry(hist.stack[hist.pos], { stagger: state.slideshow });
    syncNavButtons();
    if (!state.slideshow) announce(`Next set${navSetSuffix()}`);
  } else {
    const preloadedPlan = state.slideshow ? takeSlideshowPreloadPlan() : null;
    if (preloadedPlan) {
      state.chronoOffset = preloadedPlan.chronoOffset;
      state.displayedSlots = [...preloadedPlan.slots];
      state.displayedLayout = preloadedPlan.layout || null;
      renderGrid(state.displayedSlots, { stagger: true });
      pushHistory(state.displayedSlots, state.chronoOffset);
      rescheduleSlideshowTick();
      return;
    }

    // At the head — generate a new set
    if (state.displayMode === 'chrono') {
      state.chronoOffset = nextChronoOffset();
    }
    refresh({ stagger: state.slideshow, rotate: true });
  }
  rescheduleSlideshowTick();
}

// ==============================
// Shuffle current set
// ==============================
function shuffleCurrent() {
  if (!state.displayedSlots.length) return;
  const slots = [...state.displayedSlots];
  // Shuffle only the positions that aren't locked, so pinned cells hold both
  // their image and their place while everything else rearranges around them.
  const movable = [];
  for (let i = 0; i < slots.length; i++) {
    if (!isLocked(slots[i])) movable.push(i);
  }
  for (let a = movable.length - 1; a > 0; a--) {
    const b = Math.floor(Math.random() * (a + 1));
    const i = movable[a];
    const j = movable[b];
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  state.displayedSlots = slots;
  renderGrid(slots);
  pushHistory(slots, state.chronoOffset); // shuffled order becomes a new history entry
  announce('Shuffled the current set');
}

// ==============================
// Slideshow
// ==============================
function syncSlideshowButton() {
  btnSlideshow.classList.toggle('active', state.slideshow);
  btnSlideshow.setAttribute('aria-pressed', state.slideshow ? 'true' : 'false');
  document.body.classList.toggle('slideshow-active', state.slideshow);
  btnSlideshow.textContent = state.slideshow ? 'ON' : '\u23F5';
  btnSlideshow.setAttribute('aria-label', state.slideshow
    ? 'Slideshow is on \u2014 click to stop'
    : 'Slideshow \u2014 auto-advance sets');
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

// ==============================
// Slideshow interval popover (right-click the slideshow button)
// The interval is the one slideshow setting worth changing WHILE it runs, so it
// gets a second home here as well as in Settings. Both write the same
// `state.slideshowDuration`; `syncSlideshowDurationControls` keeps them equal.
// ==============================
const SLIDESHOW_DURATION_MIN_SEC = 1;
const SLIDESHOW_DURATION_MAX_SEC = 3600;
const SLIDESHOW_DURATION_PRESETS = [3, 5, 10, 20, 30, 60];

function slideshowDurationSeconds() {
  return Math.round(state.slideshowDuration / 1000);
}

function clampSlideshowSeconds(sec) {
  if (!Number.isFinite(sec)) return 5;
  return Math.min(SLIDESHOW_DURATION_MAX_SEC, Math.max(SLIDESHOW_DURATION_MIN_SEC, Math.round(sec)));
}

// Coarser steps as the interval grows: 1 s matters at 4 s and is invisible at 5 min.
function steppedSlideshowSeconds(sec, direction) {
  const step = sec < 10 ? 1 : sec < 60 ? 5 : sec < 300 ? 30 : 60;
  // Stepping up from 7 with a step of 1 gives 8; stepping up from 12 with a step
  // of 5 should land on 15, not 17 — snap to the step's own grid.
  const next = direction > 0
    ? Math.floor(sec / step) * step + step
    : Math.ceil(sec / step) * step - step;
  return clampSlideshowSeconds(next);
}

// The single writer for the interval. Every entry point (popover input,
// steppers, presets, the settings panel field) goes through here.
function setSlideshowDuration(sec, { persist = true } = {}) {
  const clamped = clampSlideshowSeconds(sec);
  const changed = clamped * 1000 !== state.slideshowDuration;
  state.slideshowDuration = clamped * 1000;
  syncSlideshowDurationControls();
  if (state.slideshow) rescheduleSlideshowTick();
  if (persist && changed) persistSettings();
  return clamped;
}

function syncSlideshowDurationControls() {
  const sec = slideshowDurationSeconds();
  settingSlideshowDur.value = sec;
  slideshowTimerInput.value = sec;
  slideshowTimerDec.disabled = sec <= SLIDESHOW_DURATION_MIN_SEC;
  slideshowTimerInc.disabled = sec >= SLIDESHOW_DURATION_MAX_SEC;
  for (const btn of slideshowTimerPresets.children) {
    btn.classList.toggle('current', Number(btn.dataset.seconds) === sec);
  }
}

function buildSlideshowTimerPresets() {
  slideshowTimerPresets.textContent = '';
  for (const sec of SLIDESHOW_DURATION_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.seconds = String(sec);
    btn.textContent = `${sec}s`;
    btn.setAttribute('aria-label', `Set slideshow interval to ${sec} seconds`);
    btn.addEventListener('click', () => setSlideshowDuration(sec));
    slideshowTimerPresets.append(btn);
  }
}

function slideshowTimerPopoverOpen() {
  return slideshowTimerPopover.classList.contains('open');
}

function closeSlideshowTimerPopover({ restoreFocus = false } = {}) {
  if (!slideshowTimerPopoverOpen()) return;
  slideshowTimerPopover.classList.remove('open');
  const returnFocus = slideshowTimerReturnFocus;
  slideshowTimerReturnFocus = null;
  if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

function openSlideshowTimerPopover({ focusInput = false } = {}) {
  closeGridContextMenu();
  setSettingsOpen(false);
  setFolderPanelOpen(false);
  slideshowTimerReturnFocus = btnSlideshow;
  syncSlideshowDurationControls();
  slideshowTimerPopover.classList.add('open');

  // Anchor under the button, clamped to the viewport the same way the image
  // context menu is. Measured after .open, since a display:none box has no size.
  const anchor = btnSlideshow.getBoundingClientRect();
  const maxX = window.innerWidth - slideshowTimerPopover.offsetWidth - 4;
  const maxY = window.innerHeight - slideshowTimerPopover.offsetHeight - 4;
  slideshowTimerPopover.style.left = `${Math.max(4, Math.min(anchor.left, maxX))}px`;
  slideshowTimerPopover.style.top = `${Math.max(4, Math.min(anchor.bottom + 4, maxY))}px`;

  if (focusInput) {
    slideshowTimerInput.focus({ preventScroll: true });
    slideshowTimerInput.select();
  }
  announce(`Slideshow interval ${slideshowDurationSeconds()} seconds`);
}

function toggleSlideshowTimerPopover(opts) {
  if (slideshowTimerPopoverOpen()) closeSlideshowTimerPopover({ restoreFocus: true });
  else openSlideshowTimerPopover(opts);
}

// Restart the auto-advance countdown without disturbing the preload. Hand
// interaction with a cell calls this so inspecting an image buys a full fresh
// interval instead of getting swapped out mid-gesture; the warmed next set
// stays valid either way, and arriving early just means it waits, ready.
function deferSlideshowTick() {
  clearTimeout(state.slideshowTimer);
  state.slideshowTimer = null;
  if (!state.slideshow) return;
  state.slideshowTimer = setTimeout(() => {
    if (!state.slideshow) return;
    navigateForward();
  }, state.slideshowDuration);
}

function rescheduleSlideshowTick() {
  clearSlideshowPreload();
  deferSlideshowTick();
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
  claimPoolLoad();
  clearSlideshowPreload();
  resetImageFailures();
  state.folder = null;
  state.allImages = [];
  state.displayedSlots = [];
  state.chronoOffset = 0;
  state.displayedSetId = null;
  hist.stack = [];
  hist.pos = -1;
  // Same reason as in loadImagePool: undo entries restore by pool index, and
  // this drops the pool they refer to.
  undoStack.length = 0;
  clearGridCells();
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

const BROWSE_MODES = ['multi', 'categorized', 'geo', 'mix', 'alt'];

function normalizeBrowseMode(mode) {
  return BROWSE_MODES.includes(mode) ? mode : 'multi';
}

// Every mode but 'multi' is a pool over ONE root and ONE scan: the category sidecar, its OCR, the
// categorize/exclude actions and the hash cache are all equally available in all of them. Anything
// that only needs "am I browsing a categorizer library" must ask this, not `=== 'categorized'`.
function usesCategorizedRoot(mode = state.browseMode) {
  return mode !== 'multi';
}

// A country set reaches the grid in these modes and nowhere else, so they are the ones that rotate
// on a new board and the ones whose labels can name a country.
function usesGeoSets(mode = state.browseMode) {
  return mode === 'geo' || mode === 'mix' || mode === 'alt';
}

// Mix and Alt share everything except what their ratio divides: one union pool marked up by
// `geoSidePaths`, one panel section, one set of controls.
function usesBlendPool(mode = state.browseMode) {
  return mode === 'mix' || mode === 'alt';
}

function browseModeLabel(mode) {
  if (mode === 'multi') return 'Folders';
  if (mode === 'geo') return 'Geo';
  if (mode === 'mix') return 'Mix';
  if (mode === 'alt') return 'Alt';
  return 'Categorized';
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

function setFolderLoading(loading, message = 'Loading...', mode = '') {
  folderPanel.classList.toggle('loading', loading);
  folderLoading.hidden = !loading;
  folderLoadingText.textContent = message;
  if (loading) {
    folderPanel.dataset.loadingMode = mode;
    folderPanel.dataset.loadingLabel = message;
  } else {
    delete folderPanel.dataset.loadingMode;
    delete folderPanel.dataset.loadingLabel;
  }
}

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

function categorizedScanLabel(fallback) {
  if (!categorizedScanProgress?.total) return fallback;
  const label = fallback.replace(/(?:\.\.\.|…)$/, '');
  return `${label} ${formatCount(categorizedScanProgress.scanned)} / ${formatCount(categorizedScanProgress.total)}...`;
}

function renderStartupScanProgress() {
  if (!document.body.classList.contains('app-starting')) return;
  startupLoadingText.textContent = categorizedScanProgress?.total
    ? categorizedScanLabel('Loading images...')
    : 'Loading...';
  const isLarge = (categorizedScanProgress?.total || 0) > CATEGORIZED_LARGE_LIBRARY_THRESHOLD;
  startupLoadingHint.textContent = isLarge
    ? 'Large library - the first images will appear while the rest continue loading.'
    : '';
  startupLoadingHint.hidden = !isLarge;
}

function noteCategorizedScanProgress(payload) {
  categorizedScanProgress = payload?.done
    ? null
    : { scanned: payload?.scanned || 0, total: payload?.total || 0 };
  if (document.body.classList.contains('app-starting')) {
    armStartupWatchdog(STARTUP_WATCHDOG_SCAN_MS);
    renderStartupScanProgress();
  }
  if (folderPanel.classList.contains('loading')
      && usesCategorizedRoot(folderPanel.dataset.loadingMode)) {
    folderLoadingText.textContent = categorizedScanLabel(
      folderPanel.dataset.loadingLabel || 'Scanning categories...'
    );
  }
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
  } else if (usesGeoSets()) {
    // The country beats the root name here: in these modes the root never changes but the country
    // does, every board, and that is the thing worth reading off the toolbar. It names what is on
    // the GRID — the pool may already have rotated past it.
    const set = displayedCategorizedSet();
    const prefix = browseModeLabel(state.browseMode);
    // Alt's category boards have no country at all — naming the root there is the honest label,
    // and it is also the one that tells you which half of the alternation you are looking at.
    const country = set
      ? (set.country || set.title)
      : (state.browseMode === 'alt'
        ? (state.categorizedRoot ? baseName(state.categorizedRoot) : null)
        : state.setCountry);
    label = country ? `${prefix}: ${country}` : prefix;
  } else {
    label = state.categorizedRoot ? baseName(state.categorizedRoot) : 'Categorized';
  }

  folderButtonLabel.textContent = label;
  btnFolder.classList.toggle('mode-multi', state.browseMode === 'multi');
  btnFolder.classList.toggle('mode-categorized', state.browseMode === 'categorized');
  btnFolder.classList.toggle('mode-geo', state.browseMode === 'geo');
  btnFolder.classList.toggle('mode-mix', state.browseMode === 'mix');
  btnFolder.classList.toggle('mode-alt', state.browseMode === 'alt');
  const ratio = usesBlendPool() ? ` — ${blendRatio()}% geo` : '';
  btnFolder.setAttribute(
    'aria-label',
    `Open / manage image sources — ${browseModeLabel(state.browseMode)} mode${ratio}`
  );
}

function renderFolderPanelSections() {
  folderModeTabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.browseMode === state.viewedBrowseMode);
    tab.classList.toggle('current-mode', tab.dataset.browseMode === state.browseMode);
    tab.setAttribute('aria-pressed', String(tab.dataset.browseMode === state.browseMode));
  });
  folderSectionMulti.classList.toggle('visible', state.viewedBrowseMode === 'multi');
  folderSectionCategorized.classList.toggle('visible', state.viewedBrowseMode === 'categorized');
  folderSectionGeo.classList.toggle('visible', state.viewedBrowseMode === 'geo');
  folderSectionBlend.classList.toggle('visible', usesBlendPool(state.viewedBrowseMode));
  // Categorized and Geo each own a list that Mix/Alt also show. Both render into the tab being
  // VIEWED and only that one, so switching tabs repopulates rather than paying for two copies of
  // a 53-row country list on every board.
  renderCategoriesPanel();
  renderSetsPanel();
  syncBlendControls();
}

// Switch the whole browse mode from the tab strip (or the G shortcut). Categorized <-> Geo reuses
// the scan already in memory — re-walking a 17k-image library just to change what fills the pool
// is the opposite of "switching is simple".
async function switchBrowseMode(mode) {
  state.viewedBrowseMode = mode;
  renderFolderPanelSections();
  if (mode === 'multi') {
    await enterMultiMode();
    return;
  }
  if (mode === 'geo') {
    await enterGeoMode();
    return;
  }
  if (usesBlendPool(mode)) {
    await enterBlendMode(mode);
    return;
  }
  if (hasCategorizedScan()) {
    // Not `applyCategorizedFilter()`: that one is mode-aware and would keep a mix board mixed,
    // which is the opposite of what pressing the Categorized tab means.
    loadCategorizedPool();
    return;
  }
  await enterCategorizedMode();
}

// Jump between the categorized-root pools without opening the panel.
function toggleCategorizedRootMode(mode) {
  if (!usesCategorizedRoot() && !state.categorizedRoot) {
    showToast('Choose a categorized root first');
    return;
  }
  switchBrowseMode(state.browseMode === mode ? 'categorized' : mode);
}

function loadImagePool(images, label, mode, folder = null) {
  clearSlideshowPreload();
  resetImageFailures();
  state.allImages = [...images].sort((a, b) => b.modified - a.modified);
  state.folder = folder;
  state.browseMode = mode;
  state.viewedBrowseMode = mode;
  state.chronoOffset = 0;
  // History is what remembers which country each board showed; dropping it drops those stamps too.
  state.displayedSetId = usesGeoSets(mode) ? boardSetId() : null;
  hist.stack = [];
  hist.pos = -1;
  // Undo entries splice back into this pool by index — they mean nothing once
  // it's replaced, so they retire with the history that shares their scope.
  undoStack.length = 0;
  folderNameEl.textContent = label;
  document.body.classList.toggle('no-folder', !state.allImages.length);
  renderFolderButton();
  renderFolderPanelSections();
  if (state.allImages.length) refresh();
  else {
    state.displayedSlots = [];
    clearGridCells();
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
    // No <label> wraps this row, so name the checkbox directly. The full path
    // goes in the accessible name (the visible span is truncated to baseName),
    // which replaces the old hover tooltip — informative, no mouse tooltip.
    checkbox.setAttribute('aria-label', `Show images from ${folder}`);
    checkbox.addEventListener('change', () => toggleMultiFolder(folder));
    const name = document.createElement('span');
    name.className = 'multi-folder-name';
    name.textContent = baseName(folder);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'multi-folder-remove';
    remove.textContent = 'x';
    remove.setAttribute('aria-label', `Remove ${folder}`);
    remove.addEventListener('click', e => {
      e.stopPropagation();
      removeMultiFolder(folder);
    });
    row.append(checkbox, name, remove);
    multiFolderListEl.append(row);
  }
}

// Every pool load has to be able to say "I am no longer the one that matters".
// A folder scan is slow enough to outlive the decision that started it: ticking
// two folders in a row, or switching to another browse mode mid-scan, used to
// let the OLDER scan install its pool when it finished — the second tick showed
// the first tick's images, and a scan could drag you back out of Categorized
// several seconds after you left. The categorized scan already had this guard
// (`categorizedScanSequence`); this is the same idea for every source.
let poolLoadSequence = 0;

function claimPoolLoad() {
  const ticket = ++poolLoadSequence;
  // Whatever the previous load was showing in the panel is over — it either
  // finished or has just been superseded by this one. A caller that has its own
  // scan to report turns the indicator straight back on. Without this, a slow
  // folder scan overtaken by an INSTANT source switch (the categorized pool is
  // already in memory, so nothing awaits) would leave "Scanning folders..." up
  // for good: the superseded scan is no longer allowed to touch the UI.
  setFolderLoading(false);
  return () => ticket === poolLoadSequence;
}

async function enterMultiMode() {
  normalizeMultiFolderFilter({ defaultAll: false });
  const folders = uniqueFolders(enabledMultiFolders());
  const current = claimPoolLoad();
  if (!folders.length) {
    loadImagePool([], 'No multi-folders enabled', 'multi');
    return;
  }
  setFolderLoading(true, 'Scanning folders...', 'multi');
  try {
    const images = await window.viewerAPI.listMultiFolderImages(folders);
    if (!current()) return;
    loadImagePool(images, `${folders.length} folder${folders.length === 1 ? '' : 's'}`, 'multi');
  } catch (error) {
    if (!current()) return;
    showToast('Failed to load folders');
    console.error(error);
  } finally {
    if (current()) setFolderLoading(false);
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
  // Full path as accessible name (visible text is just the folder name); no tooltip.
  if (state.categorizedRoot) categorizedRootNameEl.setAttribute('aria-label', state.categorizedRoot);
  else categorizedRootNameEl.removeAttribute('aria-label');
}

// The category checkboxes appear in two places — the Categorized tab, where they own the whole
// board, and the shared Mix/Alt tab, where they own the non-geo share. Only the visible one is
// built.
function categoriesListContainer() {
  return usesBlendPool(state.viewedBrowseMode) ? blendCategoriesList : categoriesList;
}

function renderCategoriesPanel() {
  const container = categoriesListContainer();
  container.textContent = '';
  if (!state.categorizedCategories.length) {
    const empty = document.createElement('div');
    empty.className = 'categories-empty';
    empty.textContent = 'No categorized images found.';
    container.append(empty);
    return;
  }
  for (const category of state.categorizedCategories) {
    const blocked = state.agentSafe && isAgentBlocked(category.name);
    const row = document.createElement('label');
    row.className = 'category-checkbox-row';
    if (blocked) row.classList.add('category-blocked');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.categorizedCategoryFilter.has(category.name) && !blocked;
    checkbox.disabled = blocked;
    checkbox.addEventListener('change', () => toggleCategorizedCategory(category.name));
    const name = document.createElement('span');
    name.className = 'category-checkbox-name';
    name.textContent = category.name;
    if (blocked) name.textContent += ' (blocked — agent-safe)';
    const count = document.createElement('span');
    count.className = 'category-checkbox-count';
    count.textContent = category.count;
    row.append(checkbox, name, count);
    container.append(row);
  }
}

// Sets grouped by the country they belong to, alphabetically. Selection happens at this level:
// twelve numbered Brazils are one row you can hit, not twelve rows to scroll past.
function setsByCountry() {
  const byCountry = new Map();
  for (const set of state.categorizedSets) {
    const key = set.country || set.title;
    if (!byCountry.has(key)) byCountry.set(key, []);
    byCountry.get(key).push(set);
  }
  return [...byCountry.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// The sets the current selection is allowed to draw from.
function eligibleSets() {
  if (state.setMode === 'any') return state.categorizedSets;
  if (state.setMode === 'country') {
    return state.categorizedSets.filter(set => (set.country || set.title) === state.setCountry);
  }
  return [];
}

// A shuffled bag rather than an independent random draw each time: pure random repeats itself
// often enough to look broken over a slideshow, and a bag guarantees every country is seen once
// before any repeats. The refill also avoids handing back the set already on screen.
function refillSetBag(eligible) {
  const ids = eligible.map(set => set.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  // Drawn from the end, so the last entry is the next one out.
  if (ids.length > 1 && ids[ids.length - 1] === state.categorizedSetId) {
    [ids[0], ids[ids.length - 1]] = [ids[ids.length - 1], ids[0]];
  }
  state.setBag = ids;
}

// Draw the next set from the bag and make it the current one. Pool untouched — callers decide
// whether that means an in-place swap (rotation) or a fresh `loadImagePool` (entering geo mode).
function drawNextSet() {
  const eligible = eligibleSets();
  if (!eligible.length) return null;
  if (!state.setBag.length) refillSetBag(eligible);
  const nextId = state.setBag.pop();
  const set = state.categorizedSets.find(candidate => candidate.id === nextId);
  if (!set) return null;
  state.categorizedSetId = nextId;
  return set;
}

// Swap the pool to the next set in the bag. Deliberately does NOT go through `loadImagePool`:
// that resets history, and being able to arrow back to the country you just saw is most of the
// value of rotating in the first place. Only fires where a set drives the grid — in Categorized
// the pool belongs to the category filter and nothing may take it over.
function rotateSetIfActive() {
  if (!usesGeoSets() || state.setMode === 'off') return false;
  // Alt advances its alternation here — this is the one call every "new board" path already makes
  // before generating slots, so the counter and the board it labels can never disagree. A board
  // that is about to be a CATEGORY board must not consume a country draw, or half the countries
  // would be spent unseen.
  if (state.browseMode === 'alt') {
    state.altBoardIndex++;
    if (!altBoardIsGeo()) return false;
  }
  const set = drawNextSet();
  if (!set) return false;

  let images;
  if (usesBlendPool()) {
    // Rebuild only the geo side. Rebuilding the whole blend pool would also un-hide every image
    // hidden from the categorized side — every five seconds, in a slideshow.
    const geo = categorizedSetImages(set);
    const geoPaths = new Set(geo.map(image => image.path));
    // The set being retired does NOT simply leave: a member that is also in the shown categories
    // was only on the geo side because the geo side claims duplicates, and it belongs to the
    // categorized side now. Dropping the whole outgoing set instead bled ~16 images out of the
    // pool per board — invisible for one rotation, a real hole after a slideshow.
    const kept = state.allImages.filter(image => !geoPaths.has(image.path)
      && (!state.geoSidePaths.has(image.path) || inCategoryFilter(image)));
    state.geoSidePaths = geoPaths;
    images = [...geo, ...kept];
  } else {
    images = categorizedSetImages(set);
  }
  state.allImages = [...images].sort((a, b) => b.modified - a.modified);
  document.body.classList.toggle('no-folder', !state.allImages.length);
  // Deliberately NOT relabelling here. The new country's tiles are not on screen yet — the
  // slideshow rotates a whole preload-lead ahead of showing them — so naming it now is the
  // stale-label bug in the other direction. `pushHistory` relabels once the board is rendered.
  return true;
}

function categorizedPoolLabel(mode = state.browseMode) {
  const root = state.categorizedRoot ? baseName(state.categorizedRoot) : 'Categorized';
  if (!usesGeoSets(mode)) return root;
  const set = displayedCategorizedSet();
  if (mode === 'mix') {
    // Both sides are named, because in mix both are on the board: the ratio says how much of it
    // each one got.
    const geo = set ? set.title : 'no sets';
    return `Mix ${state.mixRatio}/${100 - state.mixRatio} · ${geo} + ${root}`;
  }
  if (mode === 'alt') {
    // Only ONE side is on the board, so name only that one — with the ratio in front so the
    // rhythm you are in is still readable from a category board.
    return `Alt ${state.altRatio}/${100 - state.altRatio} · ${set ? set.title : root}`;
  }
  // "Geo" stays in front of the set title so the header always says which mode you are in.
  return set ? `Geo · ${set.title}` : 'Geo · no sets';
}

// The country list is shared by the Geo tab and the Mix/Alt tab; like the category list, only the
// tab being viewed is built, so a board never pays to render 53 rows twice.
function setsListContainer() {
  return usesBlendPool(state.viewedBrowseMode) ? blendSetsList : setsList;
}

function renderSetsPanel() {
  // Always available while there is a root: it is the one-click way back to the categorized
  // library, which has to work even when geo mode itself came up empty.
  setsClear.disabled = !state.categorizedRoot;
  const rootLabel = state.categorizedRoot ? baseName(state.categorizedRoot) : 'No root chosen';
  for (const el of [geoRootNameEl, blendRootNameEl]) {
    el.textContent = rootLabel;
    if (state.categorizedRoot) el.setAttribute('aria-label', state.categorizedRoot);
    else el.removeAttribute('aria-label');
  }
  const container = setsListContainer();
  container.textContent = '';

  if (!state.categorizedRoot) {
    const empty = document.createElement('div');
    empty.className = 'categories-empty';
    empty.textContent = 'Choose a categorized root first.';
    container.append(empty);
    return;
  }
  if (!state.categorizedSets.length) {
    const empty = document.createElement('div');
    empty.className = 'categories-empty';
    // Mix and Alt still work without sets — they just degenerate to the category pool — so say
    // that rather than leaving the tab looking broken.
    empty.textContent = usesBlendPool(state.viewedBrowseMode)
      ? `No country sets found — ${browseModeLabel(state.viewedBrowseMode)} is showing categorized images only. Build country sets in Image Categorizer, then reload from the Geo tab.`
      : 'No image sets found. Build country sets in Image Categorizer, then reload.';
    container.append(empty);
    return;
  }

  const grouped = setsByCountry();
  const current = displayedCategorizedSet();

  const addRow = ({ label, meta, active, onClick, ariaLabel, extraClass }) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `set-row${extraClass ? ` ${extraClass}` : ''}`;
    row.classList.toggle('active', active);
    row.setAttribute('aria-pressed', String(active));
    const name = document.createElement('span');
    name.className = 'set-row-name';
    name.textContent = label;
    const metaEl = document.createElement('span');
    metaEl.className = 'set-row-meta';
    metaEl.textContent = meta;
    row.append(name, metaEl);
    row.setAttribute('aria-label', ariaLabel);
    row.addEventListener('click', onClick);
    container.append(row);
    return row;
  };

  // Which mode a row click lands in is decided by the tab it was rendered into, not by the mode
  // at click time — the same list is the Geo tab's switch and the Mix/Alt tab's geo-side picker.
  const target = usesBlendPool(state.viewedBrowseMode) ? state.viewedBrowseMode : 'geo';

  const totalVideos = state.categorizedSets.reduce((sum, set) => sum + set.sources, 0);
  addRow({
    label: 'Any country',
    meta: `${state.categorizedSets.length} sets`,
    active: state.setMode === 'any',
    extraClass: 'set-row-any',
    ariaLabel: `Any country — rotate pseudorandomly across all ${state.categorizedSets.length} sets, ${totalVideos} videos`,
    onClick: () => selectSetScope('any', null, target),
  });

  for (const [country, sets] of grouped) {
    const videos = sets.reduce((sum, set) => sum + set.sources, 0);
    const limited = sets.every(set => set.quality !== 'diverse');
    const active = state.setMode === 'country' && state.setCountry === country;
    const row = addRow({
      label: country,
      meta: sets.length > 1 ? `${sets.length} sets · ${videos}v` : `${videos}v`,
      active,
      ariaLabel: `${country} — ${sets.length} set${sets.length === 1 ? '' : 's'}, ${videos} videos${
        limited ? ', limited variety' : ''
      }`,
      onClick: () => selectSetScope('country', country, target),
    });
    if (limited) {
      const badge = document.createElement('span');
      badge.className = 'set-row-badge limited';
      badge.textContent = 'limited';
      row.append(badge);
    }
    // Mark which country the board on screen is currently drawn from, so "Any country" still tells
    // you where you are.
    if (!active && current && (current.country || current.title) === country) {
      row.classList.add('set-row-showing');
    }
  }
}

// Picking a country from the panel also ENTERS the mode that shows it — clicking a country and
// staying on the category pool would be a dead control, and this is the switch the user actually
// reaches for. `target` says which of the two set-showing modes that is.
function selectSetScope(mode, country, target = usesGeoSets() ? state.browseMode : 'geo') {
  state.setMode = mode;
  state.setCountry = country;
  state.setBag = [];
  state.categorizedSetId = null;
  if (usesBlendPool(target)) applyBlendPool(target);
  else applyGeoPool();
}

// Board size for a scope: the LARGEST set it can draw, not the one that happened to come up.
// A curated sixteen displayed nine at a time is no longer the thing that was curated — but sizing
// to the draw is worse, because ~1 in 10 sets is short (some down to a single image) and under
// "Any country" one unlucky first draw would pin the grid to four tiles for the whole session.
// Rotations then leave the count alone, so the board never resizes under you mid-slideshow.
function geoScopeImageCount(eligible) {
  return eligible.reduce((max, set) => Math.max(max, set.paths.length), 0);
}

// Build (or rebuild) the geo pool for the current scope, drawing a set if none is in hand.
function applyGeoPool() {
  claimPoolLoad();
  // No remembered scope (first visit, or the remembered one is gone): "Any country" is the sane
  // default — it is the mode that works without asking the user to pick from 53 rows first.
  if (state.setMode === 'off' && state.categorizedSets.length) {
    state.setMode = 'any';
    state.setCountry = null;
    state.setBag = [];
  }
  const set = activeCategorizedSet() || drawNextSet();
  // A fresh pool discards history, so the board about to be built IS this set — say so before the
  // label is computed below, not after.
  state.displayedSetId = state.categorizedSetId;
  const images = set ? categorizedSetImages(set) : [];
  renderSetsPanel();
  // Sized before the pool loads, not after, so the board is built once at the right size.
  if (set) syncImageCountControls(geoScopeImageCount(eligibleSets()));
  loadImagePool(images, categorizedPoolLabel('geo'), 'geo');
  if (!set) {
    announce(state.categorizedSets.length
      ? 'Geo — no sets for this country'
      : 'Geo — no country sets built yet');
    return;
  }
  const scope = state.setMode === 'any' ? 'Any country' : state.setCountry;
  announce(`Geo, ${scope} — showing ${set.title}, ${images.length} images from ${set.sources} videos`);
}

// Geo mode reuses the categorized root's scan whenever one is already in memory — switching
// Categorized <-> Geo must be instant, not another walk over a 17k-image library.
async function enterGeoMode() {
  state.viewedBrowseMode = 'geo';
  renderFolderPanelSections();
  if (!state.categorizedRoot) {
    loadImagePool([], 'No categorized root', 'geo');
    return;
  }
  if (!hasCategorizedScan()) {
    // Sets resolve member hashes through the cache the scan writes, so there is nothing to show
    // part-way through: no eager pool here, unlike categorized mode.
    await enterCategorizedMode(state.categorizedRoot, { targetMode: 'geo' });
    return;
  }
  if (!state.categorizedSets.length) await loadCategorizedSets();
  applyGeoPool();
}

// ==============================
// Mix + Alt — the two modes that hold both pools at once
// ==============================
// The two sources stay separate all the way to the board: the set is a member list and the
// category filter is a 17k-image pool, so merging them into one pool and drawing at random would
// hand the set roughly 0.1% of the tiles. A ratio divides them instead — Mix divides the tiles of
// a board, Alt divides the boards (see `pickBlendPaths`). They still have to live in ONE
// `state.allImages`, because everything downstream — hide/undo, replacement picks, slideshow
// preload, the floating viewer, chrono paging — indexes that one array; `geoSidePaths` is what
// tells the two halves apart inside it.
function blendRatio(mode = state.browseMode) {
  return mode === 'alt' ? state.altRatio : state.mixRatio;
}

function buildBlendPool(set) {
  const geo = set ? categorizedSetImages(set) : [];
  const geoPaths = new Set(geo.map(image => image.path));
  // A set member that is also in the shown categories belongs to the geo side only — otherwise it
  // could land on the board twice, once from each half.
  const rest = categorizedFilteredImages('categorized').filter(image => !geoPaths.has(image.path));
  return { images: [...geo, ...rest], geoPaths, geoCount: geo.length };
}

// Build (or rebuild) the pool for `mode` from the current scope + category filter.
function applyBlendPool(mode = state.browseMode) {
  claimPoolLoad();
  if (state.setMode === 'off' && state.categorizedSets.length) {
    state.setMode = 'any';
    state.setCountry = null;
    state.setBag = [];
  }
  // Alt restarts its alternation on a fresh pool so entering the mode always opens on a geo board
  // — the mode's whole point is the country set, and opening on the category library reads as
  // "nothing happened".
  if (mode === 'alt') state.altBoardIndex = 0;
  const set = activeCategorizedSet() || drawNextSet();
  state.displayedSetId = mode === 'alt' && !altBoardIsGeo() ? null : state.categorizedSetId;
  const { images, geoPaths, geoCount } = buildBlendPool(set);
  state.geoSidePaths = geoPaths;
  renderSetsPanel();
  syncBlendControls();
  // Alt shows a set INTACT, so it sizes the board to the scope's largest set exactly as geo does —
  // a curated sixteen shown nine at a time is not the thing that was curated. Mix must not: only a
  // share of its tiles come from the set, so sizing to sixteen would blow up a nine-tile board.
  if (set && mode === 'alt') syncImageCountControls(geoScopeImageCount(eligibleSets()));
  loadImagePool(images, categorizedPoolLabel(mode), mode);
  const board = Math.max(1, expectedSlotCount() - state.emptyCount);
  const split = blendSlotSplit(board, mode);
  const label = browseModeLabel(mode);
  if (!set) {
    announce(`${label} — no country set, showing ${images.length} categorized images`);
    return;
  }
  const scope = state.setMode === 'any' ? 'Any country' : state.setCountry;
  if (mode === 'alt') {
    const cadence = altBoardCadence();
    announce(`Alt ${state.altRatio}% geo boards, ${scope} — showing ${set.title}, ${geoCount} images;`
      + ` one ${cadence.side} board in every ${cadence.every}`);
    return;
  }
  announce(`Mix ${state.mixRatio}% geo, ${scope} — ${split.geo} of ${board}`
    + ` tiles from ${set.title} (${geoCount} images), the rest categorized`);
}

// Same deal as geo: reuse the scan in memory, and only fall back to a walk of the library when
// there isn't one.
async function enterBlendMode(mode) {
  state.viewedBrowseMode = mode;
  renderFolderPanelSections();
  if (!state.categorizedRoot) {
    loadImagePool([], 'No categorized root', mode);
    return;
  }
  if (!hasCategorizedScan()) {
    await enterCategorizedMode(state.categorizedRoot, { targetMode: mode });
    return;
  }
  if (!state.categorizedSets.length) await loadCategorizedSets();
  applyBlendPool(mode);
}

// The ratio only changes how the next board is DEALT, never what is in the pool — so this rebuilds
// the board and nothing else. `rebuild: false` is the drag case: the readout tracks the slider,
// the grid waits for the release. Which ratio it sets follows the tab you are looking at, since
// the slider is shared.
function setBlendRatio(ratio, { rebuild = true, mode = state.viewedBrowseMode } = {}) {
  const key = mode === 'alt' ? 'altRatio' : 'mixRatio';
  const next = clamp(Math.round(ratio / 5) * 5, 0, 100);
  const changed = next !== state[key];
  state[key] = next;
  syncBlendControls();
  if (!rebuild) return next;
  if (changed && state.browseMode === mode) {
    syncDisplayedSetLabels();
    // Not `{rotate: true}`: changing the ratio should re-deal the board you are on, not move the
    // country out from under it.
    if (state.allImages.length) refresh();
    announce(`${browseModeLabel(mode)} ${next}% geo`);
  }
  persistSettings();
  return next;
}

// "one X in every N" for the current ratio, naming whichever side is the RARE one — past 50% the
// geo framing inverts into nonsense ("1 geo board in every 1" at 75%), and what you actually want
// to know there is how often the category library comes round. Ratios that don't divide 100 evenly
// round, which is why the panel prints the literal upcoming pattern beside this.
function altBoardCadence() {
  const rare = state.altRatio > 50 ? 100 - state.altRatio : state.altRatio;
  const side = state.altRatio > 50 ? 'categorized' : 'geo';
  return { side, every: rare > 0 ? Math.round(100 / rare) : 0 };
}

// Both blend modes drive the one shared control strip; which ratio it shows follows the tab.
function syncBlendControls() {
  const mode = usesBlendPool(state.viewedBrowseMode) ? state.viewedBrowseMode : 'mix';
  const ratio = blendRatio(mode);
  if (blendRatioSlider.value !== String(ratio)) blendRatioSlider.value = ratio;
  blendRatioValue.textContent = `${ratio}% geo`;

  if (mode === 'alt') {
    blendHintEl.textContent = 'Whole boards, one source at a time — the slider is how many of them'
      + ' are the country set.';
    const pattern = altBoardPattern().map(isGeo => (isGeo ? 'G' : 'c')).join(' ');
    const cadence = altBoardCadence();
    blendRatioDetail.textContent = ratio === 0 ? 'Categorized boards only'
      : ratio === 100 ? 'Geo boards only'
        : ratio === 50 ? `Alternating every board — next: ${pattern}`
          : `1 ${cadence.side} board in every ${cadence.every} — next: ${pattern}`;
    blendRatioSlider.setAttribute('aria-label', 'Share of boards drawn from the geo country set');
    blendRatioSlider.setAttribute('aria-valuetext', ratio > 0 && ratio < 100
      ? `${ratio} percent geo boards — one ${cadence.side} board in every ${cadence.every}`
      : `${ratio} percent geo boards`);
    return;
  }

  blendHintEl.textContent = 'Every board blends both — the slider is the tile split.';
  // `expectedSlotCount()`, not `imageCount`: with merged cells on, a board holds fewer images than
  // the count says, and quoting the unmerged size here would over-promise both halves of the split.
  const split = blendSlotSplit(Math.max(1, expectedSlotCount() - state.emptyCount), 'mix');
  const board = split.geo + split.categorized;
  blendRatioDetail.textContent = `${split.geo} geo · ${split.categorized} categorized per board of ${board}`;
  blendRatioSlider.setAttribute('aria-label', 'Share of each board drawn from the geo country set');
  blendRatioSlider.setAttribute('aria-valuetext',
    `${ratio} percent geo — ${split.geo} of ${board} tiles`);
}

// Veto this image as a geo-set member. It keeps its category and still appears everywhere else —
// this only stops it being served as geography. Persistent and honoured by image-categorizer too,
// so unlike Hide it is NOT on the undo stack: reversing it means deleting that line from
// `.image-categorizer-geo-excluded.json` (the file says so in its own note).
async function removeFromGeoSets(path) {
  const root = state.categorizedRoot;
  if (!root || state.geoExcludedPaths.has(path)) return;
  state.geoExcludedPaths.add(path);
  // Permanent, unlike Hide — so it leaves the geo side for good rather than coming back on the
  // next undo or rotation.
  state.geoSidePaths.delete(path);

  // Prune from every loaded set so no later rotation can hand it back this session.
  for (const set of state.categorizedSets) {
    const index = set.paths.indexOf(path);
    if (index >= 0) set.paths.splice(index, 1);
  }
  // And off the board + out of the live pool immediately.
  if (state.displayedSlots.includes(path)) removeDisplayedImage(path);
  else state.allImages = state.allImages.filter(image => image.path !== path);
  renderSetsPanel();

  try {
    const total = await window.viewerAPI.excludeFromGeoSets(root, [path]);
    showToast(`Removed from geo sets — ${total} excluded`);
    announce(`${baseName(path)} removed from geo sets`);
  } catch (error) {
    state.geoExcludedPaths.delete(path);
    showToast('Could not save the geo-set exclusion');
    console.error('Failed to exclude from geo sets:', error);
  }
}

// Leave geo mode for the categorized library. The country selection is kept, not cleared, so
// coming back lands where you left off.
function leaveGeoMode() {
  switchBrowseMode('categorized');
}

// Sets resolve through the hash cache the categorized scan writes, so this must run after a scan
// has populated it — an unscanned root simply yields nothing rather than failing.
async function loadCategorizedSets() {
  if (!state.categorizedRoot) {
    state.categorizedSets = [];
    renderSetsPanel();
    return;
  }
  try {
    const [sets, excluded] = await Promise.all([
      window.viewerAPI.getCategorizedSets(state.categorizedRoot),
      window.viewerAPI.getGeoExcludedPaths(state.categorizedRoot),
    ]);
    state.categorizedSets = sets || [];
    state.geoExcludedPaths = new Set(excluded || []);
  } catch {
    state.categorizedSets = [];
  }
  // A remembered country whose sets no longer exist must not keep being offered; the caller
  // re-draws from whatever scope survives.
  state.setBag = [];
  state.categorizedSetId = null;
  if (state.setMode !== 'off' && !eligibleSets().length) {
    state.setMode = 'off';
    state.setCountry = null;
  }
  renderSetsPanel();
}

// Reload button in the geo panel: pick up sets rebuilt in Image Categorizer without a rescan.
async function reloadCategorizedSets() {
  await loadCategorizedSets();
  if (state.browseMode === 'geo') applyGeoPool();
  else if (usesBlendPool()) applyBlendPool();
}

function activeCategorizedSet() {
  if (!state.categorizedSetId) return null;
  return state.categorizedSets.find(set => set.id === state.categorizedSetId) || null;
}

// The set the GRID is showing. Use this for anything the user reads off the screen; use
// `activeCategorizedSet()` only for what the pool is made of. Falls back to the pool's set so a
// board pushed before a set existed (or by a non-geo mode) still labels itself sanely.
function displayedCategorizedSet() {
  // No fallback in alt: there, `displayedSetId === null` is a positive statement — this board is a
  // category board — and falling back to the loaded set would relabel it with a country.
  const id = state.browseMode === 'alt'
    ? state.displayedSetId
    : (state.displayedSetId || state.categorizedSetId);
  if (!id) return null;
  return state.categorizedSets.find(set => set.id === id) || null;
}

// The pool when a set is selected: its members, resolved back to the scanned image records so they
// carry the same category/modified data every other code path expects.
//
// The agent-safe check is repeated here on purpose. Everywhere else that guard rides on the
// CATEGORY filter, and a set is a straight member list that bypasses category filtering entirely —
// so without this, selecting a set would be a way around the one rule that must not have one.
function categorizedSetImages(set) {
  const out = [];
  for (const path of set.paths) {
    const image = categorizedImageFor(path);
    if (!image) continue;
    if (state.agentSafe && isAgentBlocked(image.category)) continue;
    out.push(image);
  }
  return out;
}

// The pool for a mode over the categorized root. Which one it is comes from the MODE, never from
// "is a set lying around" — that is what let a remembered country silently replace the categorized
// library, and it is the one thing this must not do.
function categorizedFilteredImages(mode = state.browseMode) {
  if (mode === 'geo') {
    const set = activeCategorizedSet();
    return set ? categorizedSetImages(set) : [];
  }
  // Mix and Alt hold both, and the caller that installs this pool must also install the matching
  // `geoSidePaths` — go through `applyBlendPool`/`buildBlendPool` rather than this.
  if (usesBlendPool(mode)) return buildBlendPool(activeCategorizedSet()).images;
  return state.categorizedImages.filter(inCategoryFilter);
}

// "Would the category pool show this image?" — shared so a mix rotation, which decides one image
// at a time whether a retiring set member stays, can't drift from the filter it is standing in for.
function inCategoryFilter(image) {
  return state.categorizedCategoryFilter.has(image.category)
    && !(state.agentSafe && isAgentBlocked(image.category));
}

// A finished scan of the current root is in memory, so both categorized and geo can be entered
// without re-walking the library.
function hasCategorizedScan() {
  return !!state.categorizedRoot && state.categorizedImages.length > 0;
}

function finalizeCategorizedImagePool(images, label) {
  clearSlideshowPreload();
  resetImageFailures();
  state.allImages = [...images].sort((a, b) => b.modified - a.modified);
  state.folder = null;
  state.browseMode = 'categorized';
  state.viewedBrowseMode = 'categorized';
  folderNameEl.textContent = label;
  document.body.classList.toggle('no-folder', !state.allImages.length);
  renderFolderButton();
  renderFolderPanelSections();

  const available = new Set(state.allImages.map(image => image.path));
  const displayed = state.displayedSlots.filter(Boolean);
  if (!displayed.length || displayed.some(path => !available.has(path))) {
    if (state.allImages.length) refresh();
    else {
      state.displayedSlots = [];
      // clearGridCells(), not a bare textContent wipe: that leaks manualZoomActiveCount, and it
      // would leave a merged layout installed with no cells for it to describe.
      clearGridCells();
      syncNavButtons();
    }
  }
  persistSettings();
}

// Scan a categorized root and load the pool for `targetMode`. Both categorized and geo come
// through here on a cold start — one scan feeds both; only what it pours into the pool differs.
async function enterCategorizedMode(
  root = state.categorizedRoot,
  { eager = false, targetMode = 'categorized' } = {},
) {
  // Geo (and the geo half of mix) has nothing to show part-way through: its sets resolve member
  // hashes through the cache this scan writes, so a partial pool would resolve to nothing.
  if (usesGeoSets(targetMode)) eager = false;
  if (!root) {
    loadImagePool([], 'No categorized root', targetMode);
    renderCategorizedRootRow();
    renderCategoriesPanel();
    renderSetsPanel();
    return;
  }
  // Claimed here and NOT in the eager partial-pool install below: the partial
  // pool is this same operation showing its first images early, so it must not
  // read as a newer load that supersedes its own finished scan.
  const current = claimPoolLoad();
  const scanNumber = ++categorizedScanSequence;
  const scanId = `${windowLabel}-${scanNumber}-${Date.now()}`;
  const partialImages = [];
  let partialPoolShown = false;
  let settleEager = () => {};
  const eagerFirstImages = new Promise(resolve => {
    let settled = false;
    settleEager = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });

  setFolderLoading(true, 'Scanning categories...', targetMode);
  const unlisten = await window.viewerAPI.onCategorizedScanProgress(payload => {
    if (scanNumber !== categorizedScanSequence) return;
    if (payload?.scanId !== scanId || payload?.root !== root) return;
    noteCategorizedScanProgress(payload);
    if (!eager || !payload.images?.length) return;

    partialImages.push(...payload.images);
    state.categorizedImages = [...partialImages];
    state.categorizedCategories = payload.categories || state.categorizedCategories;
    if (partialPoolShown) return;
    const filtered = state.categorizedCategoryFilter.size
      ? partialImages.filter(image => state.categorizedCategoryFilter.has(image.category))
      : partialImages;
    // Super Image Viewer fills a grid, so wait only until that first grid can
    // be populated (normally the next 100 ms batch), not for the whole library.
    const initialImageTarget = Math.max(1, state.imageCount - state.emptyCount);
    if (filtered.length < initialImageTarget && !payload.done) return;
    if (!filtered.length) return;

    state.categorizedRoot = root;
    loadImagePool(filtered, baseName(root), 'categorized');
    partialPoolShown = true;
    settleEager(true);
  }).catch(() => null);

  const finalize = (async () => {
    try {
      const scan = await window.viewerAPI.scanCategorizedRoot(root, scanId);
      // Two ways this scan can be obsolete by now: another categorized scan
      // started (scanNumber), or the user moved to a different SOURCE entirely
      // while this one ran (current) — a folder scan that finished first used
      // to be silently replaced by this one seconds later.
      if (scanNumber !== categorizedScanSequence || !current()) return false;
      state.categorizedRoot = scan.root;
      state.categorizedImages = scan.images;
      state.categorizedCategories = scan.categories;
      const available = new Set(scan.categories.map(category => category.name));
      const kept = [...state.categorizedCategoryFilter].filter(name => available.has(name));
      state.categorizedCategoryFilter = new Set(kept.length ? kept : [...available]);
      renderCategorizedRootRow();
      renderCategoriesPanel();
      // Only now: sets resolve member hashes through the cache this scan just wrote, so loading
      // them any earlier would resolve nothing and drop every set as empty.
      await loadCategorizedSets();
      if (targetMode === 'geo') {
        applyGeoPool();
        return true;
      }
      if (usesBlendPool(targetMode)) {
        applyBlendPool(targetMode);
        return true;
      }
      const filtered = categorizedFilteredImages('categorized');
      const poolLabel = categorizedPoolLabel('categorized');
      if (partialPoolShown) {
        finalizeCategorizedImagePool(filtered, poolLabel);
      } else {
        loadImagePool(filtered, poolLabel, 'categorized');
      }
      return true;
    } catch (error) {
      if (scanNumber === categorizedScanSequence && current()) {
        showToast('Failed to load categorized root');
        console.error(error);
      }
      return false;
    } finally {
      unlisten?.();
      settleEager(false);
      if (scanNumber === categorizedScanSequence) {
        categorizedScanProgress = null;
        setFolderLoading(false);
      }
    }
  })();

  return eager ? Promise.race([eagerFirstImages, finalize]) : finalize;
}

// Both root-choose buttons land here — the root is shared by categorized and geo, so picking one
// from the geo panel keeps you in geo rather than dumping you back into the category list.
async function chooseCategorizedRoot(targetMode = 'categorized') {
  const folder = await window.viewerAPI.selectFolder();
  if (!folder) return;
  await enterCategorizedMode(folder, { targetMode });
}

// In agent-safe mode, blocked categories can't even sit in the filter set, so
// the category panel and persisted filter reflect what's actually shown.
function sanitizeCategoryFilter() {
  if (!state.agentSafe) return;
  for (const name of [...state.categorizedCategoryFilter]) {
    if (isAgentBlocked(name)) state.categorizedCategoryFilter.delete(name);
  }
}

// Hand the grid to the CATEGORY pool, whatever mode it was in. The Categorized tab means exactly
// this, and so does anything else that has decided the category filter now owns the whole board.
function loadCategorizedPool() {
  claimPoolLoad();
  sanitizeCategoryFilter();
  renderCategoriesPanel();
  renderSetsPanel();
  const filtered = categorizedFilteredImages('categorized');
  loadImagePool(filtered, categorizedPoolLabel('categorized'), 'categorized');
  const selected = [...state.categorizedCategoryFilter];
  announce(selected.length
    ? `Showing ${selected.join(', ')} — ${filtered.length} images`
    : 'No categories selected');
}

// A change to the category FILTER, applied wherever that filter is driving something. In mix it
// drives a share of the board, so it rebuilds the mix; everywhere else the filter IS the board.
function applyCategorizedFilter() {
  if (usesBlendPool()) {
    sanitizeCategoryFilter();
    renderCategoriesPanel();
    applyBlendPool();
    return;
  }
  loadCategorizedPool();
}

function toggleCategorizedCategory(name) {
  // Ticking a category is an unambiguous "show me this pool", so outside mix it also leaves geo
  // mode rather than silently changing a filter that is not driving anything. In mix the filter
  // owns half the board already, so the tick stays put and just re-deals.
  if (state.categorizedCategoryFilter.has(name)) state.categorizedCategoryFilter.delete(name);
  else state.categorizedCategoryFilter.add(name);
  applyCategorizedFilter();
}

function setAllCategorizedCategories(checked) {
  state.categorizedCategoryFilter = checked
    ? new Set(state.categorizedCategories.map(category => category.name))
    : new Set();
  applyCategorizedFilter(); // sanitizes out blocked categories when agent-safe
}

// Turn agent-safe mode on/off. On => blocked categories are stripped from the
// filter, hidden from display, and disabled in the panel; the board is rebuilt
// so anything currently shown from a blocked category is dropped immediately.
function setAgentSafe(on) {
  state.agentSafe = !!on;
  document.body.classList.toggle('agent-safe', state.agentSafe);
  // Rebuild whichever pool is live — in geo/mix mode that re-filters the set on screen; it must
  // not change the mode out from under an agent that deliberately entered it.
  if (state.browseMode === 'geo') {
    applyGeoPool();
  } else if (usesBlendPool()) {
    applyBlendPool();
  } else if (state.browseMode === 'categorized' && state.categorizedRoot) {
    loadCategorizedPool();
  } else {
    renderCategoriesPanel();
  }
  announce(state.agentSafe ? 'Agent-safe mode on' : 'Agent-safe mode off');
  return state.agentSafe;
}

// ==============================
// Right-click image menu
// ==============================
// path -> scan record, over `state.categorizedImages`. Rebuilt only when that
// array is REPLACED (identity check), and it holds the very same record objects,
// so an in-place category edit is visible through it without invalidation.
//
// This exists because the lookups below run per tile per board: the linear
// `find` they replaced cost 43 ms to render one 99-tile board against the real
// 30k-image library — 99 scans of 30k records, every five seconds in a
// slideshow. With the index the same render is ~3 ms.
let categorizedIndexSource = null;
let categorizedIndex = new Map();

function categorizedImageIndex() {
  if (categorizedIndexSource !== state.categorizedImages) {
    categorizedIndexSource = state.categorizedImages;
    categorizedIndex = new Map(state.categorizedImages.map(image => [image.path, image]));
  }
  return categorizedIndex;
}

function categorizedImageFor(path) {
  return categorizedImageIndex().get(path) || null;
}

function categoryForPath(path) {
  const entry = categorizedImageFor(path);
  return entry ? entry.category : null;
}

// ==============================
// Copy image to the clipboard
// ==============================
// Deliberately re-fetches the file into a throwaway `Image` instead of drawing
// the tile that is already on screen: the grid's <img> elements load WITHOUT
// `crossOrigin`, so the asset: response is opaque and any canvas they touch is
// tainted — `toBlob` then throws SecurityError. Setting crossOrigin on the grid
// images instead would fix the taint but change their cache key, so every
// slideshow preload (which warms plain `new Image()` requests) would miss and
// refetch. One extra local read on an explicit copy is the cheaper trade.
// Same technique as the floating viewer's Ctrl+C — see image-view.js.
function loadImageForCopy(path) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode failed'));
    img.src = window.viewerAPI.getFileUrl(path);
  });
}

const COPY_IMAGE_TIMEOUT_MS = 10000;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); }),
  ]);
}

// PNG regardless of the source format: it is the one bitmap flavour every
// Windows target pastes, and the clipboard holds pixels, not the file.
//
// Both awaits are on a timeout because neither can be trusted to settle. A file
// the scan listed can be gone or truncated (`loadImageForCopy` would then reject,
// but a stalled protocol read would not), and WebView2's clipboard-write gate has
// been measured on this machine to hang forever rather than reject when it wants
// a permission the window cannot show — it is `granted` for this app's origin,
// checked in both dev and release, but a silent stall must still surface as a
// failed toast rather than nothing at all.
async function copyImageToClipboard(path) {
  try {
    const img = await withTimeout(loadImageForCopy(path), COPY_IMAGE_TIMEOUT_MS, 'load timed out');
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty image');
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('encode failed');
    await withTimeout(
      navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]),
      COPY_IMAGE_TIMEOUT_MS,
      'clipboard write timed out',
    );
    showToast(`Copied ${baseName(path)}`);
  } catch (error) {
    console.error('Copy image failed:', error);
    showToast('Could not copy image');
  }
}

function closeGridContextMenu({ restoreFocus = false } = {}) {
  gridContextMenu.classList.remove('open');
  const returnFocus = gridContextMenuReturnFocus;
  gridContextMenuReturnFocus = null;
  if (restoreFocus && returnFocus?.isConnected && !returnFocus.hidden && !returnFocus.disabled) {
    returnFocus.focus({ preventScroll: true });
  }
}

function openGridContextMenu(x, y) {
  gridContextMenu.classList.add('open');
  const maxX = window.innerWidth - gridContextMenu.offsetWidth - 4;
  const maxY = window.innerHeight - gridContextMenu.offsetHeight - 4;
  gridContextMenu.style.left = `${Math.max(4, Math.min(x, maxX))}px`;
  gridContextMenu.style.top = `${Math.max(4, Math.min(y, maxY))}px`;
}

function openImageContextMenu(path, x, y, { focusMenu = false, returnFocus = null } = {}) {
  gridContextMenu.textContent = '';
  gridContextMenuReturnFocus = returnFocus;
  gridContextMenu.setAttribute('aria-label', `Image actions for ${baseName(path)}`);

  const fileInfo = document.createElement('div');
  fileInfo.className = 'context-menu-file-info';
  fileInfo.setAttribute('aria-hidden', 'true');
  const fileLabel = document.createElement('div');
  fileLabel.className = 'context-menu-title';
  fileLabel.textContent = 'Image file';
  const fileName = document.createElement('div');
  fileName.className = 'context-menu-file-name';
  fileName.textContent = baseName(path);
  fileInfo.append(fileLabel, fileName);
  gridContextMenu.append(fileInfo);

  const actionSeparator = document.createElement('div');
  actionSeparator.className = 'context-menu-separator';
  actionSeparator.setAttribute('role', 'separator');
  gridContextMenu.append(actionSeparator);

  // Copy — puts the image's pixels on the clipboard. First because it is the
  // only item here that changes nothing: everything below alters what the board
  // or the library holds, so the harmless one is what a mis-aimed click lands on.
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.setAttribute('role', 'menuitem');
  copyBtn.setAttribute('aria-label', `Copy ${baseName(path)} to the clipboard`);
  const copyLabel = document.createElement('span');
  copyLabel.textContent = 'Copy image';
  copyBtn.append(copyLabel);
  copyBtn.addEventListener('click', () => {
    closeGridContextMenu({ restoreFocus: true });
    copyImageToClipboard(path);
  });
  gridContextMenu.append(copyBtn);

  const copySeparator = document.createElement('div');
  copySeparator.className = 'context-menu-separator';
  copySeparator.setAttribute('role', 'separator');
  gridContextMenu.append(copySeparator);

  // Lock — pins this cell so board refreshes never swap its image, and files
  // the image into the "Previously pinned" category. Available in every mode.
  const locked = isLocked(path);
  const lockBtn = document.createElement('button');
  lockBtn.type = 'button';
  lockBtn.setAttribute('role', 'menuitem');
  lockBtn.classList.toggle('current', locked);
  const lockLabel = document.createElement('span');
  lockLabel.textContent = locked ? 'Unlock image' : 'Lock image';
  lockBtn.append(lockLabel);
  lockBtn.addEventListener('click', () => {
    closeGridContextMenu({ restoreFocus: true });
    toggleLock(path);
  });
  gridContextMenu.append(lockBtn);

  // Hide — available in every browse mode; view-only, no categorization change.
  // Disabled while locked: a pinned cell shouldn't be pulled off the board.
  const hideBtn = document.createElement('button');
  hideBtn.type = 'button';
  hideBtn.setAttribute('role', 'menuitem');
  hideBtn.disabled = locked;
  if (locked) hideBtn.setAttribute('aria-label', 'Hide — unlock first');
  const hideLabel = document.createElement('span');
  hideLabel.textContent = 'Hide image';
  hideBtn.append(hideLabel);
  hideBtn.addEventListener('click', () => {
    if (isLocked(path)) return;
    closeGridContextMenu({ restoreFocus: true });
    hideImage(path);
  });
  gridContextMenu.append(hideBtn);

  // Remove from geo sets — a set-building veto, not a recategorization. Offered whenever a
  // categorized root is active, not only in geo mode: the point is to be able to knock out a bad
  // member the moment you notice it, including before it ever lands in a set.
  if (usesCategorizedRoot() && state.categorizedRoot) {
    const excluded = state.geoExcludedPaths.has(path);
    const geoBtn = document.createElement('button');
    geoBtn.type = 'button';
    geoBtn.setAttribute('role', 'menuitem');
    geoBtn.disabled = excluded;
    const geoLabel = document.createElement('span');
    geoLabel.textContent = excluded ? 'Removed from geo sets' : 'Remove from geo sets';
    geoBtn.append(geoLabel);
    if (excluded) geoBtn.classList.add('current');
    geoBtn.setAttribute(
      'aria-label',
      excluded
        ? 'Already removed from geo sets'
        : 'Remove from geo sets — keeps its category, only stops it being used as geography'
    );
    geoBtn.addEventListener('click', () => {
      closeGridContextMenu({ restoreFocus: true });
      if (!excluded) removeFromGeoSets(path);
    });
    gridContextMenu.append(geoBtn);
  }

  // Categorize — only meaningful when browsing a categorized root (either mode).
  if (usesCategorizedRoot()) {
    const separator = document.createElement('div');
    separator.className = 'context-menu-separator';
    separator.setAttribute('role', 'separator');
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
        btn.setAttribute('role', 'menuitem');
        btn.classList.toggle('current', isCurrent);
        const name = document.createElement('span');
        name.textContent = category.name;
        const mark = document.createElement('span');
        mark.textContent = isCurrent ? '✓' : '';
        btn.append(name, mark);
        btn.addEventListener('click', () => {
          closeGridContextMenu({ restoreFocus: true });
          if (!isCurrent) categorizeImage(path, category.name);
        });
        gridContextMenu.append(btn);
      }
    }
  }

  openGridContextMenu(x, y);
  if (focusMenu) lockBtn.focus({ preventScroll: true });
}

// Reflect a category change locally so counts and the filter panel update
// without re-hashing the whole root; the sidecar on disk is the source of
// truth on the next rescan.
function applyLocalCategoryChange(path, category) {
  const entry = categorizedImageFor(path);
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

// syncHistoryHead only covers the entry being viewed; the other ≤49 sets still
// list the image. Blank it out of all of them, or navigating back re-renders a
// set holding an image that is no longer in the pool — on screen, yet invisible
// to every replacement path. Returns where it was, so undo can put it back.
//
// Entries are held by reference, not index: pushHistory shifts the stack once
// it hits HISTORY_MAX, which would leave indices pointing at the wrong sets.
function purgeFromHistory(path) {
  const hits = [];
  for (const entry of hist.stack) {
    entry.slots.forEach((slot, slotIndex) => {
      if (slot !== path) return;
      hits.push({ entry, slotIndex });
      entry.slots[slotIndex] = null;
    });
  }
  return hits;
}

// Only refill slots still blank: the viewed entry gets rewritten wholesale by
// syncHistoryHead, and that copy is authoritative over anything recorded here.
function restoreToHistory(hits, path) {
  for (const { entry, slotIndex } of hits) {
    if (entry.slots[slotIndex] === null) entry.slots[slotIndex] = path;
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
// filter; never touches categorization on disk. Returns what it took so undo
// can put it back.
function removeDisplayedImage(path) {
  const slotIndex = state.displayedSlots.indexOf(path);
  // Chrono mode reads the pool positionally, so record where the image sat —
  // restoring it at the end would silently reorder the timeline.
  const poolIndex = state.allImages.findIndex(image => image.path === path);
  const removal = {
    path,
    slotIndex,
    poolIndex,
    image: poolIndex === -1 ? null : state.allImages[poolIndex],
    historyHits: purgeFromHistory(path),
  };
  state.allImages = state.allImages.filter(image => image.path !== path);
  clearSlideshowPreload();
  if (slotIndex === -1) return removal;
  const shown = new Set(state.displayedSlots.filter(Boolean));
  state.displayedSlots[slotIndex] = pickReplacementImage(shown);
  renderGrid(state.displayedSlots);
  syncHistoryHead();
  if (state.slideshow) rescheduleSlideshowTick();
  return removal;
}

// Reverse of removeDisplayedImage: pool entry back at its original index, the
// blanked history slots refilled, and the image back into the slot it vacated.
function restoreRemovedImage(removal) {
  if (removal.image && !state.allImages.some(image => image.path === removal.path)) {
    state.allImages.splice(Math.min(removal.poolIndex, state.allImages.length), 0, removal.image);
  }
  restoreToHistory(removal.historyHits, removal.path);
  clearSlideshowPreload();
  // The pool restore above is the part that matters; putting it back in its old
  // slot is a nicety, and two cases make it the wrong move. The grid may have
  // shrunk past the slot, where writing would extend displayedSlots and resize
  // the layout. Or the image may somehow already be on screen, where writing
  // would show it twice — purgeFromHistory should rule that out, but undo
  // shouldn't be the thing that proves it wrong.
  if (removal.slotIndex !== -1
    && removal.slotIndex < state.displayedSlots.length
    && !state.displayedSlots.includes(removal.path)) {
    state.displayedSlots[removal.slotIndex] = removal.path;
    renderGrid(state.displayedSlots);
    syncHistoryHead();
  }
  if (state.slideshow) rescheduleSlideshowTick();
}

// ==============================
// Undo (Ctrl+Z)
// ==============================
// Hide and categorize both fire straight off a right-click menu and can pull
// an image off the grid on the spot — a slip is otherwise unwalkable-back,
// since the image leaves the pool and, in categorized mode, the filter too.
function pushUndo(entry) {
  undoStack.push(entry);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}

function hideImage(path) {
  pushUndo({ type: 'hide', path, removal: removeDisplayedImage(path) });
  announce(`Hid ${baseName(path)}`);
}

// Ctrl+Z auto-repeats while held, and a categorize undo is an async sidecar
// round-trip. Run them strictly one at a time: entries unwind by pool index and
// only hold that meaning in stack order, and overlapping sidecar writes would
// read-modify-write the same file on top of each other.
function undoLastAction() {
  undoChain = undoChain
    .then(runNextUndo)
    .catch(error => console.error('Undo failed:', error));
  return undoChain;
}

async function runNextUndo() {
  const entry = undoStack.pop();
  if (!entry) {
    showToast('Nothing to undo');
    return;
  }

  if (entry.type === 'hide') {
    restoreRemovedImage(entry.removal);
    showToast(`Unhid ${baseName(entry.path)}`);
    return;
  }

  try {
    await window.viewerAPI.setImageCategory(entry.root, entry.path, entry.previousCategory);
    applyLocalCategoryChange(entry.path, entry.previousCategory);
    if (entry.removal) restoreRemovedImage(entry.removal);
    showToast(`Moved back to ${entry.previousCategory}`);
  } catch (error) {
    console.error('Failed to undo categorize:', error);
    // The sidecar write never landed, so the move still stands — put the entry
    // back rather than swallowing the only way to reverse it.
    pushUndo(entry);
    showToast('Failed to undo');
  }
}

async function categorizeImage(path, category) {
  if (!state.categorizedRoot) return;
  const root = state.categorizedRoot;
  const previousCategory = categoryForPath(path);
  try {
    await window.viewerAPI.setImageCategory(root, path, category);
    applyLocalCategoryChange(path, category);

    // Only the category pool can filter an image out on the spot; a geo set is a fixed member
    // list, so recategorizing inside it leaves the board alone. In mix that is per-image: the
    // categorized half filters, the set members sitting beside it do not.
    const onCategorySide = state.browseMode === 'categorized'
      || (usesBlendPool() && !state.geoSidePaths.has(path));
    const filteredOut = onCategorySide && !state.categorizedCategoryFilter.has(category);
    let removal = null;
    if (appSettings.instantFilterCategorized && filteredOut) {
      removal = removeDisplayedImage(path);
      showToast(`Moved to ${category} — hidden`);
    } else {
      showToast(`Moved to ${category}`);
    }
    // Records skipped by the scan (no category on disk) never reach the grid,
    // so a displayed image always has one to go back to.
    if (previousCategory) {
      pushUndo({ type: 'categorize', path, root, previousCategory, removal });
    }
  } catch (error) {
    console.error('Failed to categorize image:', error);
    showToast('Failed to categorize image');
  }
}

// ==============================
// Image count (max 99)
// ==============================
// Count + its widgets, without touching the board. For callers that are about to rebuild the pool
// anyway (entering a geo set), so the grid is laid out once, at the size the set asks for.
function syncImageCountControls(n) {
  n = clamp(Math.round(n), 4, 99);
  state.imageCount = n;
  state.emptyCount = Math.min(state.emptyCount, n - 1);
  countDisplayEl.textContent  = n;
  emptyDisplayEl.textContent  = state.emptyCount;
  settingSlider.value         = n;
  settingCountVal.textContent = n;
  // The mix readout is "N geo · M categorized per board" — a board-size change moves both. It also
  // moves how many merges fit, so this goes through the merge sync, which refreshes the blend one.
  syncMergeControls();
  return n;
}

function setImageCount(n) {
  syncImageCountControls(n);
  if (state.allImages.length) refresh();
  persistSettings();
}

function bumpCount(up) {
  setImageCount(state.imageCount + (up ? 1 : -1));
}

// ==============================
// Merged cells — the toolbar layer
// ==============================
// Toggling or re-aiming the slider re-deals the board rather than only affecting the next one:
// the point of the control is to see the trade, and waiting a whole slideshow interval to find out
// what 70% looks like makes it unusable. Like the blend sliders it never rotates the country —
// a plain `refresh()`, so you re-shape the set you are looking at instead of leaving it.
function setMergeEnabled(enabled, { rebuild = true } = {}) {
  const next = !!enabled;
  const changed = next !== state.mergeEnabled;
  state.mergeEnabled = next;
  syncMergeControls();
  if (rebuild && changed) {
    if (state.allImages.length) refresh();
    announce(next ? `Merged cells on — ${mergeDetailText()}` : 'Merged cells off');
  }
  persistSettings();
  return next;
}

function setMergeRatio(ratio, { rebuild = true } = {}) {
  const next = clamp(Math.round(Number(ratio) / 5) * 5, 0, 100);
  const changed = next !== state.mergeRatio;
  state.mergeRatio = next;
  syncMergeControls();
  if (!rebuild) return next;
  if (changed && state.mergeEnabled) {
    if (state.allImages.length) refresh();
    announce(`Merge ${next}% — ${mergeDetailText()}`);
  }
  persistSettings();
  return next;
}

// What the slider means on the CURRENT board size, in the units the setting is actually felt in.
// The maximum moves with the image count (4 on a 16-position board, 1 on a 9-position one), so a
// bare percentage says very little on its own — and the range, not the average, is the point: the
// mode exists so sets differ from each other.
function mergeDetailText() {
  const max = maxMergesFor(state.imageCount);
  if (!max) return `a ${state.imageCount}-image board has no room for a larger cell`;
  if (!state.mergeEnabled || state.mergeRatio <= 0) return `all ${state.imageCount} cells the same size`;
  if (state.mergeRatio >= 100) {
    return `always ${max} merged — ${state.imageCount - max * (MERGE_SPAN * MERGE_SPAN - 1)} large images per set`;
  }
  const typical = Math.round((max * state.mergeRatio) / 100);
  return `0–${max} merged per set, typically ${typical}`
    + ` — about ${expectedSlotCount()} images instead of ${state.imageCount}`;
}

// One sync for BOTH copies of the control — the toolbar strip and the folder panel. They are the
// same setting, so nothing here may read a widget's value; everything comes off `state`.
function syncMergeControls() {
  const max = maxMergesFor(state.imageCount);
  const detail = mergeDetailText();
  const compact = state.mergeEnabled && max
    ? `${state.mergeRatio}% · ~${expectedSlotCount()}`
    : `${state.mergeRatio}%`;

  btnMerge.classList.toggle('active', state.mergeEnabled);
  btnMerge.setAttribute('aria-pressed', state.mergeEnabled ? 'true' : 'false');
  btnMerge.setAttribute('aria-label', state.mergeEnabled
    ? `Merged cells are on — ${detail}`
    : 'Merged cells are off — merge cells to show fewer, larger images per set');
  mergeRatioSlider.disabled = !state.mergeEnabled;
  if (mergeRatioSlider.value !== String(state.mergeRatio)) mergeRatioSlider.value = state.mergeRatio;
  mergeRatioValue.textContent = compact;
  mergeRatioSlider.setAttribute('aria-valuetext', `${state.mergeRatio} percent — ${detail}`);

  mergePanelToggle.checked = state.mergeEnabled;
  mergePanelSlider.disabled = !state.mergeEnabled;
  if (mergePanelSlider.value !== String(state.mergeRatio)) mergePanelSlider.value = state.mergeRatio;
  mergePanelValue.textContent = compact;
  mergePanelSlider.setAttribute('aria-valuetext', `${state.mergeRatio} percent — ${detail}`);
  mergePanelDetail.textContent = detail.charAt(0).toUpperCase() + detail.slice(1) + '.';

  // The blend readouts project "per board of N", and merging is what makes N differ from the
  // image count — so they have to be recomputed whenever this moves.
  syncBlendControls();
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
  syncBlendControls();
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
  const random = state.displayMode === 'random';
  btnModeRandom.classList.toggle('active', random);
  btnModeChrono.classList.toggle('active', !random);
  btnModeRandom.setAttribute('aria-pressed', random ? 'true' : 'false');
  btnModeChrono.setAttribute('aria-pressed', random ? 'false' : 'true');
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

// Pull a manual pan back inside what the cell can actually show. The reachable
// range is a function of the cell's pixel size, so a resize (or a move to a
// monitor with another scale factor) can leave a pan pointing past the edge —
// re-clamping keeps the user's zoom instead of resetting it, which is what
// recenterManualZoom would do.
function clampManualZoomToCell(cell) {
  const img = cell && cell.querySelector('img');
  const manual = img && imageManualZoom.get(img);
  if (!manual || manual.resetting || !img.naturalWidth || !img.naturalHeight) return;
  const rect = cell.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const totalScale = zoomFillScale(appSettings.zoomFillAmount) * manual.scale;
  const { maxTx, maxTy } = manualZoomOverflow(img, rect, totalScale);
  manual.tx = clamp(manual.tx, -maxTx, maxTx);
  manual.ty = clamp(manual.ty, -maxTy, maxTy);
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
  applyZoomFillToCell(cell);
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

// Grid-wide zoom-fill inputs that don't depend on any single cell — computed
// once per call site instead of once per cell, so hot paths that only touch
// one cell (an image finishing loading, a drag/wheel pan-zoom tick) don't
// redo this work for every other cell in the grid.
function zoomFillGlobals() {
  const coverMode = isZoomFillCover(appSettings.zoomFillAmount);
  const position = coverMode ? zoomBiasPosition() : { x: 50, y: 50 };
  const curtainSide = coverMode ? null : zoomCurtainSide();
  const curtainCoverage = curtainSide ? zoomCurtainCoverage() : 0;
  return { coverMode, position, curtainSide, curtainCoverage };
}

// Applies zoom-fill/portrait-fill/manual-zoom/curtain to a single cell. Call
// this directly (instead of applyZoomFillToImages) whenever only one cell
// changed — it skips the getBoundingClientRect layout read that a full-grid
// pass would otherwise force on every *other* cell.
function applyZoomFillToCell(cell, globals = zoomFillGlobals()) {
  const { coverMode, position, curtainSide, curtainCoverage } = globals;
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
}

function applyZoomFillToImages() {
  const globals = zoomFillGlobals();
  imageGrid.style.setProperty('--zoom-fill-x', `${globals.position.x}%`);
  imageGrid.style.setProperty('--zoom-fill-y', `${globals.position.y}%`);
  imageGrid.querySelectorAll('.grid-cell').forEach(cell => applyZoomFillToCell(cell, globals));
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
  btnZoomFill.setAttribute('aria-pressed', fillEnabled ? 'true' : 'false');
  btnZoomFill.textContent = fillEnabled ? 'Fill' : 'Fit';
  btnZoomFill.setAttribute('aria-label', coverEnabled
    ? 'Zoom to fill is on'
    : fillEnabled
      ? 'Partial zoom is on'
      : 'Zoom to fill is off');
  const atLevel1 = fillEnabled && fillAmount === ZOOM_FILL_PRESETS[1];
  const atLevel2 = fillEnabled && fillAmount === ZOOM_FILL_PRESETS[2];
  const atLevel3 = fillEnabled && fillAmount === ZOOM_FILL_PRESETS[3];
  btnZoomLevel1.classList.toggle('active', atLevel1);
  btnZoomLevel2.classList.toggle('active', atLevel2);
  btnZoomLevel3.classList.toggle('active', atLevel3);
  btnZoomLevel1.setAttribute('aria-pressed', atLevel1 ? 'true' : 'false');
  btnZoomLevel2.setAttribute('aria-pressed', atLevel2 ? 'true' : 'false');
  btnZoomLevel3.setAttribute('aria-pressed', atLevel3 ? 'true' : 'false');
  zoomFillSlider.value = String(fillAmount);
  zoomFillSlider.setAttribute('aria-label', fillEnabled
    ? `Zoom to fill amount ${fillAmount}`
    : 'No zoom to fill');
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
  if (hidden) closeSlideshowTimerPopover();
}

// ==============================
// Settings panel
// ==============================
let settingsReturnFocus = null;
function setSettingsOpen(open) {
  state.settingsOpen = open;
  settingsPanel.classList.toggle('open', open);
  btnSettings.classList.toggle('active', open);
  settingsPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (open) {
    settingsReturnFocus = document.activeElement;
    const first = settingsPanel.querySelector('button, input, select, [tabindex]');
    if (first) first.focus();
  } else if (settingsReturnFocus) {
    if (typeof settingsReturnFocus.focus === 'function') settingsReturnFocus.focus();
    settingsReturnFocus = null;
  }
}

// ==============================
// Shortcuts overlay (?)
// ==============================
let shortcutsReturnFocus = null;
function setShortcutsOpen(open) {
  state.shortcutsOpen = open;
  shortcutsOverlay.classList.toggle('open', open);
  if (open) {
    shortcutsReturnFocus = document.activeElement;
    shortcutsClose.focus();
  } else if (shortcutsReturnFocus) {
    if (typeof shortcutsReturnFocus.focus === 'function') shortcutsReturnFocus.focus();
    shortcutsReturnFocus = null;
  }
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
      // The country selection persists; which set it happens to be showing does not — that is
      // re-rolled on every new board, so saving it would only pin one random draw. This is the
      // geo SCOPE, not a mode switch: `browseMode` alone decides whether it drives the pool.
      categorizedSetMode: state.setMode === 'off' ? null : state.setMode,
      categorizedSetCountry: state.setCountry,
      mixGeoRatio:       state.mixRatio,
      altGeoRatio:       state.altRatio,
      // Merging is a layout layer, not a source, so it persists on its own axis and stays put
      // across every browse-mode switch.
      mergeCellsEnabled: state.mergeEnabled,
      mergeCellsRatio:   state.mergeRatio,
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
      focusIndicators:   appSettings.focusIndicators,
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

// Auto-slideshow follows the startup mode whenever that mode names a source of its own; only
// 'multi' leaves the choice open (its own source list is the folder one).
function autoSlideshowSourceForMode(mode) {
  return mode === 'multi' ? 'folders' : mode;
}

async function useCurrentSourceAtStartup() {
  appSettings.startupBrowseMode = state.browseMode;
  appSettings.autoSlideshowSource = autoSlideshowSourceForMode(state.browseMode);

  if (state.browseMode === 'multi') {
    appSettings.startupMultiFolders = [...state.multiFolders];
    appSettings.startupMultiFolderFilter = [...state.multiFolderFilter];
  } else {
    appSettings.startupCategorizedRoot = state.categorizedRoot;
    appSettings.startupCategorizedCategoryFilter = [...state.categorizedCategoryFilter];
  }

  syncStartupSourceSettings();
  await persistSettings();
  showToast('Saved startup source');
}

async function saveWindowPositionPreset(preset) {
  try {
    // Report the logical coordinates back: this record is what puts the window
    // home again after a monitor layout change has swept it elsewhere, so a bare
    // "saved" leaves no way to tell a good stamp from one taken on the wrong screen.
    const saved = await window.viewerAPI.saveWindowPositionPreset(preset);
    const name = preset === 'first' ? 'Saved 1st window default' : 'Saved 2nd+ window default';
    showToast(saved
      ? `${name} — ${saved.x},${saved.y} · ${saved.width}×${saved.height}`
      : name);
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
  // A visual toast is invisible to a screen reader — mirror it to the live
  // region so transient status/errors are announced too.
  announce(msg);
}

// ==============================
// Accessibility helpers
// ==============================
let announceTimer = null;

// Politely announce a message to screen readers (and any agent reading the DOM)
// via the #a11y-status live region. Clearing first, then setting on a later
// tick, guarantees repeated identical messages ("New set") re-announce instead
// of being coalesced away.
function announce(msg) {
  if (!a11yStatus || !msg) return;
  a11yStatus.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => { a11yStatus.textContent = msg; }, 60);
}

// Keyboard focus outline is on by default; the toggle only adds the suppressing
// body class. Mouse focus never shows a ring anyway (see the :focus-visible CSS).
function applyFocusIndicators() {
  document.body.classList.toggle('no-focus-indicators', !appSettings.focusIndicators);
}

// Whether the OS asks for reduced motion. CSS handles transitions/animations;
// this lets the JS side skip the slideshow stagger too (staggered swaps are
// motion the media query can't reach).
function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  // Blur pointer-driven clicks only (detail > 0) so the mouse never leaves a
  // lingering focus. Keyboard activation (Enter/Space) reports detail === 0 and
  // must keep focus, so the ring stays and the user doesn't lose their place.
  if (button && e.detail !== 0) button.blur();
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
categorizedRootChoose.addEventListener('click', () => chooseCategorizedRoot('categorized'));
geoRootChoose.addEventListener('click', () => chooseCategorizedRoot('geo'));
blendRootChoose.addEventListener('click', () =>
  chooseCategorizedRoot(usesBlendPool(state.viewedBrowseMode) ? state.viewedBrowseMode : 'mix'));
// Readout tracks the drag; the board re-deals on release. Re-rendering up to 99 tiles per slider
// step is the one thing that would make the slider feel broken.
blendRatioSlider.addEventListener('input', () => setBlendRatio(blendRatioSlider.value, { rebuild: false }));
blendRatioSlider.addEventListener('change', () => {
  setBlendRatio(blendRatioSlider.value);
  blendRatioSlider.blur();
});
btnMerge.addEventListener('click', () => setMergeEnabled(!state.mergeEnabled));
// Same input/change split as the blend slider, and for the same reason.
mergeRatioSlider.addEventListener('input', () => setMergeRatio(mergeRatioSlider.value, { rebuild: false }));
mergeRatioSlider.addEventListener('change', () => {
  setMergeRatio(mergeRatioSlider.value);
  mergeRatioSlider.blur();
});
// The folder-panel copy. Both write through the same setters, so whichever one you touch the other
// follows — syncMergeControls() repaints both off `state`, never off the widget that moved.
mergePanelToggle.addEventListener('change', () => setMergeEnabled(mergePanelToggle.checked));
mergePanelSlider.addEventListener('input', () => setMergeRatio(mergePanelSlider.value, { rebuild: false }));
mergePanelSlider.addEventListener('change', () => setMergeRatio(mergePanelSlider.value));
categoriesSelectAll.addEventListener('click', () => setAllCategorizedCategories(true));
categoriesSelectNone.addEventListener('click', () => setAllCategorizedCategories(false));
categoriesRescan.addEventListener('click', () => enterCategorizedMode());
setsClear.addEventListener('click', leaveGeoMode);
setsReload.addEventListener('click', reloadCategorizedSets);
folderModeTabs.forEach(tab => {
  tab.addEventListener('click', () => switchBrowseMode(tab.dataset.browseMode));
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

const zoomBiasDisplay = document.getElementById('zoom-bias-display');
zoomBiasDisplay.addEventListener('click', e => {
  e.stopPropagation();
  appSettings.zoomFillBiasDirection = '';
  appSettings.zoomFillBiasAmount = 0;
  syncZoomFillControls();
  persistSettings();
});
// It's a role="button" (reset), so activate it with Enter/Space too.
zoomBiasDisplay.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    zoomBiasDisplay.click();
  }
});

buildSlideshowTimerPresets();
syncSlideshowDurationControls();

btnSlideshow.addEventListener('click', e => {
  // A left-click while the interval popover is open just dismisses it, rather
  // than also flipping the slideshow the user was about to time.
  if (slideshowTimerPopoverOpen()) {
    e.stopPropagation();
    closeSlideshowTimerPopover({ restoreFocus: true });
    return;
  }
  toggleSlideshow();
});

// Right-click / ContextMenu key / Shift+F10 on the slideshow button -> interval popover.
// stopPropagation keeps the document-level handler (which suppresses the native
// webview menu and opens the image menu) out of it.
let slideshowTimerKeyOpenStamp = -Infinity;

btnSlideshow.addEventListener('keydown', e => {
  if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
  e.preventDefault();
  e.stopPropagation();
  slideshowTimerKeyOpenStamp = e.timeStamp;
  if (!slideshowTimerPopoverOpen()) openSlideshowTimerPopover({ focusInput: true });
});

btnSlideshow.addEventListener('contextmenu', e => {
  e.preventDefault();
  e.stopPropagation();
  // Some webviews dispatch a synthetic contextmenu alongside the ContextMenu /
  // Shift+F10 keydown handled above. Don't let that second event toggle closed
  // what the first just opened.
  if (e.timeStamp - slideshowTimerKeyOpenStamp < 400) return;
  // A real right-click carries button 2; a keyboard-synthesized one carries 0,
  // and only that one should steal focus into the field.
  toggleSlideshowTimerPopover({ focusInput: e.button !== 2 });
});

slideshowTimerPopover.addEventListener('click', e => e.stopPropagation());
slideshowTimerPopover.addEventListener('contextmenu', e => {
  e.preventDefault();
  e.stopPropagation();
});

slideshowTimerPopover.addEventListener('keydown', e => {
  // The global keydown handler bails out inside INPUTs, so Escape is handled here.
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  closeSlideshowTimerPopover({ restoreFocus: true });
});

slideshowTimerDec.addEventListener('click', () => {
  setSlideshowDuration(steppedSlideshowSeconds(slideshowDurationSeconds(), -1));
});
slideshowTimerInc.addEventListener('click', () => {
  setSlideshowDuration(steppedSlideshowSeconds(slideshowDurationSeconds(), +1));
});

// 'input' applies as you type so the running slideshow retimes live; the field is
// re-normalised on 'change' (blur/Enter), which is also where a half-typed or
// empty value gets snapped back to something legal.
slideshowTimerInput.addEventListener('input', () => {
  const raw = parseInt(slideshowTimerInput.value, 10);
  if (!Number.isFinite(raw) || raw < SLIDESHOW_DURATION_MIN_SEC) return;
  const typed = slideshowTimerInput.value;
  setSlideshowDuration(raw);
  // Keep what is being typed intact — syncing would rewrite "10" to "10" but
  // also fight a user midway through typing "100".
  slideshowTimerInput.value = typed;
});
slideshowTimerInput.addEventListener('change', () => {
  setSlideshowDuration(parseInt(slideshowTimerInput.value, 10) || slideshowDurationSeconds());
});

btnShuffle.addEventListener('click',   shuffleCurrent);
btnRefresh.addEventListener('click',   () => refresh({ rotate: true }));

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

settingFocusIndicators.addEventListener('change', async () => {
  appSettings.focusIndicators = settingFocusIndicators.checked;
  applyFocusIndicators();
  await persistSettings();
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
  appSettings.startupBrowseMode = normalizeBrowseMode(settingStartupBrowseMode.value);
  appSettings.autoSlideshowSource = autoSlideshowSourceForMode(appSettings.startupBrowseMode);
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
  setSlideshowDuration(parseInt(settingSlideshowDur.value, 10) || 5);
});

settingsPanel.addEventListener('click', e => e.stopPropagation());
folderPanel.addEventListener('click', e => e.stopPropagation());

shortcutsClose.addEventListener('click', () => setShortcutsOpen(false));
shortcutsPanel.addEventListener('click', e => e.stopPropagation());
// Backdrop click dismisses; the panel above stops its own clicks reaching here.
shortcutsOverlay.addEventListener('click', () => setShortcutsOpen(false));
document.addEventListener('click', () => {
  setSettingsOpen(false);
  setFolderPanelOpen(false);
  closeGridContextMenu();
  closeSlideshowTimerPopover();
});

// Suppress the native webview context menu everywhere (removes "More tools"
// and "Inspect"). Right-clicking an image opens a custom menu with its file
// name, Hide in any mode, and move-to-category when browsing a categorized root.
document.addEventListener('contextmenu', e => {
  e.preventDefault();

  // A right-click anywhere else dismisses the slideshow interval popover.
  if (slideshowTimerPopoverOpen()) {
    closeSlideshowTimerPopover();
    return;
  }

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

gridContextMenu.addEventListener('keydown', e => {
  const items = [...gridContextMenu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
  const index = items.indexOf(document.activeElement);

  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeGridContextMenu({ restoreFocus: true });
    return;
  }

  if (e.key === 'Tab') {
    closeGridContextMenu({ restoreFocus: true });
    return;
  }

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    e.stopPropagation();
    if (!items.length) return;
    let next = index;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowDown') next = (index + 1 + items.length) % items.length;
    else next = (index - 1 + items.length) % items.length;
    items[next].focus({ preventScroll: true });
    return;
  }

  // Keep menu-item activation and other keystrokes from triggering the app's
  // global image-grid shortcuts behind the open menu.
  e.stopPropagation();
});

// Keep the menu glued to where it was opened rather than letting it drift on
// scroll/resize; simplest is to just dismiss it.
window.addEventListener('resize', closeGridContextMenu);
imageGrid.addEventListener('scroll', closeGridContextMenu, true);

// ==============================
// Reflow on resize / DPI change
// ==============================
// Every number the zoom-fill layer computes — the portrait fill scale, the
// manual pan clamp — is derived from a cell's pixel rect, and nothing recomputed
// them when that rect changed. Resize the window (or drag it to a monitor with a
// different scale factor, which changes each cell's CSS size without resizing
// the window at all) and every tile kept the transform it was given for the old
// cell until the next board replaced it: portraits over- or under-filled, and a
// panned image could sit past an edge that had moved.
//
// A ResizeObserver on the grid catches both causes, since a DPI change resizes
// the grid in CSS pixels too. Coalesced to one pass per frame — a drag-resize
// fires this continuously, and the pass reads layout for every cell.
let zoomFillReflowFrame = null;

function scheduleZoomFillReflow() {
  if (zoomFillReflowFrame !== null) return;
  zoomFillReflowFrame = requestAnimationFrame(() => {
    zoomFillReflowFrame = null;
    if (!imageGrid.childElementCount) return;
    // Re-clamp any manual pan first: the reachable range shrank or grew with
    // the cell, and a pan left past the new limit shows dead space.
    if (manualZoomActiveCount > 0) {
      for (const cell of imageGrid.querySelectorAll('.grid-cell.manual-zoom')) {
        clampManualZoomToCell(cell);
      }
    }
    applyZoomFillToImages();
  });
}

new ResizeObserver(scheduleZoomFillReflow).observe(imageGrid);
window.addEventListener('resize', scheduleZoomFillReflow);

// ==============================
// Keyboard shortcuts
// ==============================
document.addEventListener('keydown', e => {
  const focused = document.activeElement;
  if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) return;

  // ? — toggle the shortcut reference. Every layout that has a '?' reports it
  // as e.key regardless of which chord produces it, so no need to spell those out.
  if (e.key === '?') {
    e.preventDefault();
    setShortcutsOpen(!state.shortcutsOpen);
    return;
  }

  // The reference is a modal: don't let the shortcuts it documents fire behind
  // it. Escape (below) still backs out.
  if (state.shortcutsOpen && e.key !== 'Escape') return;

  // Ctrl+Z — undo the last hide / categorize
  if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
    e.preventDefault();
    undoLastAction();
    return;
  }

  // Shift+Q — toggle title bar + toolbar
  if ((e.key === 'Q' || e.key === 'q') && e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    setUiHidden(!state.uiHidden);
    return;
  }

  // Space — new set
  if (e.key === ' ' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    refresh({ rotate: true });
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

  // G — flip between the categorized library and geo country sets
  if ((e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    toggleCategorizedRootMode('geo');
    return;
  }

  // Shift+M — merged cells on/off. A layer over whatever mode is showing, so unlike G/M/A it
  // switches nothing about the source; it must be tested before plain M, which would otherwise
  // swallow the chord.
  if ((e.key === 'M' || e.key === 'm') && e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    setMergeEnabled(!state.mergeEnabled);
    return;
  }

  // M — flip between the categorized library and the mixed board
  if ((e.key === 'm' || e.key === 'M') && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    toggleCategorizedRootMode('mix');
    return;
  }

  // A — flip between the categorized library and alternating boards
  if ((e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    toggleCategorizedRootMode('alt');
    return;
  }

  // Escape — unwind modals one level at a time
  if (e.key === 'Escape') {
    e.preventDefault();
    if (state.shortcutsOpen) { setShortcutsOpen(false); return; }
    if (gridContextMenu.classList.contains('open')) {
      closeGridContextMenu({ restoreFocus: true });
      return;
    }
    if (slideshowTimerPopoverOpen()) {
      closeSlideshowTimerPopover({ restoreFocus: true });
      return;
    }
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
function armStartupWatchdog(ms = STARTUP_WATCHDOG_INIT_MS) {
  clearTimeout(startupWatchdogTimer);
  startupWatchdogTimer = setTimeout(() => {
    if (document.body.classList.contains('app-starting')) {
      document.body.classList.remove('app-starting');
    }
  }, ms);
}

function clearStartupOverlay() {
  clearTimeout(startupWatchdogTimer);
  document.body.classList.remove('app-starting');
}

function finishStartupLoadingAfterFirstImage() {
  if (!document.body.classList.contains('app-starting')) return;
  const images = [...imageGrid.querySelectorAll('img[data-src]')];
  if (!images.length) {
    clearStartupOverlay();
    return;
  }

  armStartupWatchdog(STARTUP_WATCHDOG_IMAGE_MS);
  startupLoadingText.textContent = 'Loading images...';
  startupLoadingHint.hidden = true;
  let pending = images.length;
  let settled = false;
  const cleanup = () => {
    images.forEach(img => {
      img.removeEventListener('load', loaded);
      img.removeEventListener('error', failed);
    });
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    cleanup();
    clearStartupOverlay();
  };
  const loaded = () => finish();
  const failed = () => {
    pending--;
    if (pending <= 0) finish();
  };

  images.forEach(img => {
    img.addEventListener('load', loaded);
    img.addEventListener('error', failed);
  });
  setTimeout(() => {
    if (images.some(img => img.complete && img.naturalWidth > 0)) finish();
    else if (images.every(img => img.complete)) finish();
  }, 0);
}

// ==============================
// Agent / LLM control surface (window.SIV)
// ==============================
// A deliberate, stable API for a coding agent or LLM driving this window (e.g.
// over CDP: `await window.SIV.getShown()`) so it can use the grid as image
// context the way a person browses it. Everything a screen reader can perceive,
// this exposes as data — the accessible-name string and the manifest are one and
// the same. Category safety is enforced here: SIV can never surface a blocked
// category (Explicit), and setAgentSafe(true) extends that guarantee to the
// whole window (human UI included) for the session.
window.SIV = {
  version: '1.5',

  // --- introspection ---
  blockedCategories: () => [...AGENT_BLOCKED_CATEGORIES],
  isAgentSafe: () => state.agentSafe,
  getState() {
    // `showing` must mean what is on the grid, which after an arrow-back is an older set than the
    // one the pool holds.
    const set = displayedCategorizedSet();
    return {
      browseMode: state.browseMode,
      categorizedRoot: state.categorizedRoot,
      agentSafe: state.agentSafe,
      imageCount: state.imageCount,
      shown: state.displayedSlots.filter(Boolean).length,
      categories: state.categorizedCategories.map(c => ({
        name: c.name, count: c.count, blocked: isAgentBlocked(c.name),
      })),
      filter: [...state.categorizedCategoryFilter],
      // Geo mode: the scope that is rotating, and the set currently drawn from it. In mix the
      // same fields describe the geo SHARE of the board.
      geo: {
        scope: state.setMode,
        country: state.setCountry,
        setsAvailable: state.categorizedSets.length,
        showing: set ? { id: set.id, title: set.title, country: set.country, sources: set.sources } : null,
      },
      // How a mix board is split. `geoTiles`/`categorizedTiles` are what the next board will deal,
      // not a count of what is on screen (locks and a short set both move that).
      mix: {
        ratio: state.mixRatio,
        geoTiles: blendSlotSplit(Math.max(1, expectedSlotCount() - state.emptyCount), 'mix').geo,
        categorizedTiles: blendSlotSplit(Math.max(1, expectedSlotCount() - state.emptyCount), 'mix').categorized,
        geoPoolSize: state.geoSidePaths.size,
      },
      // Cell merging, which is a LAYER over whichever mode above is active rather than one of
      // them: `imageCount` stays the number of grid POSITIONS, and `merged`/`cells` describe how
      // many of them the board on screen fused. `possible` is the ceiling at this board size.
      merge: {
        enabled: state.mergeEnabled,
        ratio: state.mergeRatio,
        possible: maxMergesFor(state.imageCount),
        merged: state.displayedLayout ? state.displayedLayout.merged : 0,
        cells: state.displayedSlots.length,
        expectedCells: expectedSlotCount(),
      },
      // Alt's alternation. `boardIsGeo` describes the board ON SCREEN; `upcoming` is the pattern
      // from here, so an agent can tell "one more board" from "four more" before the set it wants.
      alt: {
        ratio: state.altRatio,
        boardIndex: state.altBoardIndex,
        boardIsGeo: altBoardIsGeo(),
        cadence: altBoardCadence(),
        upcoming: altBoardPattern().map(isGeo => (isGeo ? 'geo' : 'categorized')),
      },
    };
  },

  // Currently displayed tiles, each with the same description a screen reader
  // hears plus a viewport rect (so an agent can crop a screenshot to one tile).
  // Awaits OCR so `ocr`/`name` are populated.
  async getShown() {
    await enrichAccessibleOcr();
    const cells = [...imageGrid.querySelectorAll('.grid-cell')];
    const total = cells.length;
    return cells.map((cell, i) => {
      const img = cell.querySelector('img');
      const path = img && img.getAttribute('data-src');
      if (!path || cell.classList.contains('empty-slot')) return null;
      const r = cell.getBoundingClientRect();
      return {
        index: i,
        of: total,
        // Merged cells make the tiles differ in size, which `rect` already shows but only by
        // comparison — this states it, so one tile read on its own is still self-describing.
        large: cellSpan(cell) > 1,
        path,
        filename: baseName(path),
        category: usesCategorizedRoot() ? categoryForPath(path) : null,
        ocr: ocrTextCache.get(path) || '',
        name: accessibleImageName(cell, path),
        rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      };
    }).filter(Boolean);
  },

  // --- browsing (mirror the human actions) ---
  async newSet() { refresh({ rotate: true }); return this.getShown(); },
  async next()   { navigateForward(); return this.getShown(); },
  async prev()   { navigateBack(); return this.getShown(); },
  async shuffle() { shuffleCurrent(); return this.getShown(); },

  // --- browse mode ---
  // Geo is a mode, not a filter: entering it replaces the pool with one curated country set and
  // leaving it restores the category pool. The blocked-category guard holds in both.
  async setBrowseMode(mode) {
    if (!BROWSE_MODES.includes(mode)) throw new Error(`Unknown browse mode: ${mode}`);
    await switchBrowseMode(mode);
    return this.getState();
  },
  // Countries that have at least one set, in panel order.
  geoCountries() {
    return setsByCountry().map(([country, sets]) => ({
      country,
      sets: sets.length,
      sources: sets.reduce((sum, set) => sum + set.sources, 0),
      diverse: sets.some(set => set.quality === 'diverse'),
    }));
  },
  // `country` = null rotates across every country ("Any country"). Enters geo mode — or, if the
  // window is already mixing, re-scopes the geo share without dropping the mix.
  async setGeoScope(country = null) {
    if (country && !state.categorizedSets.some(set => (set.country || set.title) === country)) {
      throw new Error(`No geo sets for: ${country}`);
    }
    const target = usesBlendPool() ? state.browseMode : 'geo';
    state.viewedBrowseMode = target;
    renderFolderPanelSections();
    if (!hasCategorizedScan()) await (usesBlendPool(target) ? enterBlendMode(target) : enterGeoMode());
    selectSetScope(country ? 'country' : 'any', country, target);
    return this.getState();
  },

  // The tile split for a mixed board: 0 = all categorized, 100 = all geo. Rounded to the same 5%
  // steps the slider uses. Only meaningful in mix mode, but settable from anywhere.
  setMixRatio(ratio) {
    setBlendRatio(Number(ratio), { mode: 'mix' });
    return this.getState().mix;
  },

  // The share of BOARDS that are geo boards in alt mode. Same 0–100 in 5% steps; 50 is strict
  // alternation.
  setAltRatio(ratio) {
    setBlendRatio(Number(ratio), { mode: 'alt' });
    return this.getState().alt;
  },

  // --- merged cells (composes with every browse mode) ---
  // On/off, and the 0-100 propensity in the same 5% steps the slider uses. Both re-deal the board,
  // so `merged` in the returned state describes what is on screen, not what was asked for.
  setMergeEnabled(enabled) {
    setMergeEnabled(!!enabled);
    return this.getState().merge;
  },
  setMergeRatio(ratio) {
    setMergeRatio(Number(ratio));
    return this.getState().merge;
  },

  // --- category control (always allowlist-enforced) ---
  setAgentSafe,
  setCategories(names) {
    const wanted = (Array.isArray(names) ? names : [])
      .filter(n => state.categorizedCategories.some(c => c.name === n) && !isAgentBlocked(n));
    state.categorizedCategoryFilter = new Set(wanted);
    applyCategorizedFilter();
    return [...state.categorizedCategoryFilter];
  },
  // Select every category except the blocked ones — the safe "show me everything".
  selectAllSafe() {
    const names = state.categorizedCategories.map(c => c.name).filter(n => !isAgentBlocked(n));
    state.categorizedCategoryFilter = new Set(names);
    applyCategorizedFilter();
    return [...state.categorizedCategoryFilter];
  },
};

armStartupWatchdog();

(async () => {
  try {
    // Let the overlay paint before the first native calls. The timer keeps
    // startup moving when an occluded Windows webview suspends animation frames.
    await new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      requestAnimationFrame(finish);
      setTimeout(finish, 200);
    });
    windowLabel = await window.viewerAPI.getWindowLabel().catch(() => 'main');
    // Restore locked cells before any pool loads so the first board rebuilds
    // with pinned images already in place.
    loadLockedImages();
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
    // The remembered geo SCOPE, restored regardless of mode — it only reaches the grid if
    // `browseMode` is 'geo'. Provisional until `loadCategorizedSets` confirms the country still
    // has sets; it clears if not.
    state.setMode = ['any', 'country'].includes(s.categorizedSetMode) ? s.categorizedSetMode : 'off';
    state.setCountry = state.setMode === 'country' ? (s.categorizedSetCountry || null) : null;
    if (state.setMode === 'country' && !state.setCountry) state.setMode = 'off';
    state.mixRatio = clamp(Math.round((s.mixGeoRatio ?? 50) / 5) * 5, 0, 100);
    state.altRatio = clamp(Math.round((s.altGeoRatio ?? 50) / 5) * 5, 0, 100);
    state.mergeEnabled = !!s.mergeCellsEnabled;
    state.mergeRatio = clamp(Math.round((s.mergeCellsRatio ?? 50) / 5) * 5, 0, 100);
    state.slideshowDuration = Math.max(1000, s.slideshowDuration || 5000);
    appSettings.squareAppCorners = !!s.squareAppCorners;
    appSettings.focusIndicators = s.focusIndicators !== false;
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
    const loadedAutoSource = ['folders', 'categorized', 'geo', 'mix', 'alt'].includes(s.autoSlideshowSource)
      ? s.autoSlideshowSource
      : autoSlideshowSourceForMode(loadedStartupBrowseMode);
    appSettings.autoSlideshowSource = loadedStartupBrowseMode === 'multi'
      ? loadedAutoSource
      : autoSlideshowSourceForMode(loadedStartupBrowseMode);
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
    syncSlideshowDurationControls();
    settingSquareAppCorners.checked = appSettings.squareAppCorners;
    settingFocusIndicators.checked = appSettings.focusIndicators;
    applyFocusIndicators();
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
    syncMergeControls();
    syncNavButtons();
    if (appSettings.autoHideUiOnStartup) {
      setUiHidden(true);
    }
    await window.viewerAPI.setWindowSquareCorners(appSettings.squareAppCorners).catch(() => {});

    armStartupWatchdog(STARTUP_WATCHDOG_SCAN_MS);
    if (shouldAutoStartSlideshow() && (windowLabel === 'main' || isSecondWindow())) {
      await loadAutoSlideshowSource();
    } else if ((windowLabel === 'main' || isSecondWindow()) && hasConfiguredStartupSource()) {
      await loadConfiguredStartupSource();
    } else {
      if (windowLabel === 'main' || isSecondWindow()) {
        if (state.browseMode === 'multi' && state.multiFolders.length) {
          await enterMultiMode();
        } else if (state.browseMode === 'geo' && state.categorizedRoot) {
          await enterGeoMode();
        } else if (usesBlendPool() && state.categorizedRoot) {
          await enterBlendMode(state.browseMode);
        } else if (state.browseMode === 'categorized' && state.categorizedRoot) {
          await enterCategorizedMode(undefined, { eager: true });
        } else {
          clearDisplayFolder();
        }
      } else {
        clearDisplayFolder();
      }
    }
  } catch (error) {
    console.error('Startup loading failed:', error);
    renderMultiFolderList();
    renderCategorizedRootRow();
    renderCategoriesPanel();
    renderFolderPanelSections();
    renderFolderButton();
    syncStartupSourceSettings();
    syncSlideshowButton();
    syncModeButtons();
    syncZoomFillControls();
    syncMergeControls();
    syncNavButtons();
  }

  if (state.allImages.length) finishStartupLoadingAfterFirstImage();
  else clearStartupOverlay();

  startupDone = true;
  if (shouldAutoStartSlideshow() && state.allImages.length) {
    startSlideshow();
  }
})();
