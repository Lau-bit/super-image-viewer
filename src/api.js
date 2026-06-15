'use strict';

const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;
const dialog = tauri?.dialog;
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
};
