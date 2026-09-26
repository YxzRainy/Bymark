import { createApp } from "vue";
import App from "./App";
import { loadArchives } from './archives';
import { loadBrandTemplates } from './brandTemplates';
import { IMAGE_ASSET_KEY, SCENE_IMAGE_ASSET_KEY, SETTINGS_STORAGE_KEY, loadAvatar, loadImageAsset } from './bymark';
import { loadDrafts } from './drafts';
import { hasSharedStorage, initializeSharedStorage, needsLocalMigration, type SharedSnapshot } from './sharedStorage.ts';
import "./index.css";

function localJson(key: string) {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) : null
  } catch {
    return null
  }
}

async function mountApp() {
  if (await hasSharedStorage()) {
    let local: SharedSnapshot = {
      settings: null, exportPreferences: null, drafts: [], archives: [],
      brandTemplates: [], avatar: null, image: null, sceneImage: null,
    }
    if (needsLocalMigration()) {
      const [drafts, archives, brandTemplates, avatar, image, sceneImage] = await Promise.all([
        loadDrafts(), loadArchives(), loadBrandTemplates(), loadAvatar(),
        loadImageAsset(IMAGE_ASSET_KEY), loadImageAsset(SCENE_IMAGE_ASSET_KEY),
      ])
      local = {
        settings: localJson(SETTINGS_STORAGE_KEY),
        exportPreferences: localJson('bymark-export-preferences-v1'),
        drafts, archives, brandTemplates, avatar, image, sceneImage,
      }
    }
    await initializeSharedStorage(local)
  }
  createApp(App).mount('#root')
}

mountApp().catch((error) => {
  console.error(error)
  const root = document.getElementById('root')
  const status = root?.querySelector('.boot-status')
  if (status) status.textContent = '本地共享数据暂时无法读取。请检查开发服务后刷新页面。'
  else if (root) root.textContent = '本地共享数据暂时无法读取。请检查开发服务后刷新页面。'
})
