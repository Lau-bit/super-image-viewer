'use strict';

const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;
const dialog = tauri?.dialog;
const opener = tauri?.opener;
const convertFileSrc = tauri?.core?.convertFileSrc;

if (!invoke || !dialog || !convertFileSrc) {
  console.error('Tauri API is not available.');
}

window.viewerAPI = {
  selectFolder: async () => {
    const selected = await dialog.open({
      multiple: false,
      directory: true,
      title: 'Select image folder',
    });
    return selected || null;
  },

  listFolderImages: (folder) => invoke('list_folder_images', { folder }),
  loadSettings: () => invoke('load_settings'),
  saveSettings: (settings) => invoke('save_settings', { settings }),
  getWindowLabel: () => invoke('get_window_label'),
  saveWindowPositionPreset: (preset) => invoke('save_window_position_preset', { preset }),
  resetWindowPositionPreset: (preset) => invoke('reset_window_position_preset', { preset }),
  setWindowSquareCorners: (square) => invoke('set_window_square_corners', { square }),

  getFileUrl: (filePath) => convertFileSrc(filePath),

  windowStartDrag: () => invoke('window_start_drag'),
  windowMinimize: () => invoke('window_minimize'),
  windowClose: () => invoke('window_close'),

  openImageWindow: (path, rect, naturalWidth, naturalHeight) => invoke('open_image_window', {
    path,
    rectX: rect.x,
    rectY: rect.y,
    rectW: rect.width,
    rectH: rect.height,
    naturalW: naturalWidth,
    naturalH: naturalHeight,
  }),
  getAssignedImagePath: () => invoke('get_assigned_image_path'),
  revealInFolder: (path) => opener.revealItemInDir(path),
};
