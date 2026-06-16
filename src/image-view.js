'use strict';

const img = document.getElementById('image');
const closeZone = document.getElementById('close-zone');
const btnClose = document.getElementById('btn-close');
const contextMenu = document.getElementById('context-menu');
const menuCopy = document.getElementById('menu-copy');
const menuReveal = document.getElementById('menu-reveal');
const menuClose = document.getElementById('menu-close');

let currentPath = null;

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

function startWindowDrag(e) {
  if (e.button !== 0 || e.detail > 1 || isInteractiveTarget(e.target)) return;
  closeContextMenu();
  window.viewerAPI.windowStartDrag().catch(console.error);
}

btnClose.addEventListener('click', closeWindow);
img.addEventListener('dblclick', closeWindow);
document.addEventListener('pointerdown', startWindowDrag);

img.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openContextMenu(e.clientX, e.clientY);
});

document.addEventListener('click', (e) => {
  if (!contextMenu.contains(e.target)) closeContextMenu();
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
  if (e.key === 'Escape') {
    closeContextMenu();
    return;
  }
  if (e.key === 'Delete') {
    e.preventDefault();
    closeWindow();
    return;
  }
  if ((e.key === 'c' || e.key === 'C') && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    copyImageToClipboard();
  }
});

init();
