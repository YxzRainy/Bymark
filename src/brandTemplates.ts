import type { BymarkState } from "./bymark";
import { DEFAULT_IMAGE_SCALE, DEFAULT_SCENE_CARD_HEIGHT, DEFAULT_SCENE_CARD_PADDING, SCENE_CARD_HEIGHT_MAX, SCENE_CARD_HEIGHT_MIN, SCENE_CARD_PADDING_MAX, SCENE_CARD_PADDING_MIN, themeLabel } from "./default-settings.ts";
import { normalizeSceneBackdrop } from "./sceneBackdrops.ts";
import { normalizeSocialMetricScale } from './socialMetrics.ts';
import { isSharedStorageEnabled, loadSharedValue, removeSharedValue, saveSharedValue } from './sharedStorage.ts';

export type BrandProfile = Pick<
  BymarkState,
  | "name"
  | "userId"
  | "showSignature"
  | "signature"
  | "socialReplies"
  | "socialReposts"
  | "socialLikes"
  | "socialViews"
  | "socialMetricScale"
  | "theme"
  | "ratio"
  | "exportMode"
  | "fontScale"
  | "lineHeightScale"
  | "imagePosition"
  | "imageAlignment"
  | "imageScale"
  | "visualStyle"
  | "canvasStyle"
  | "sceneBackdrop"
  | "sceneFocus"
  | "sceneCardRatio"
  | "sceneCardScale"
  | "sceneCardHeight"
  | "sceneCardPadding"
  | "sceneCardX"
  | "sceneCardY"
  | "sceneOverlay"
>;

export interface BrandTemplate {
  id: string;
  title: string;
  profile: BrandProfile;
  avatar: string | null;
  createdAt: string;
  updatedAt: string;
}

const DATABASE = "bymark-brand-templates";
const LEGACY_DATABASE = "postmark-brand-templates";
const STORE = "templates";

const makeId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const openDatabase = (name = DATABASE) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open brand templates"));
  });

export const brandProfileFor = (state: BymarkState): BrandProfile => ({
  name: state.name,
  userId: state.userId,
  showSignature: state.showSignature,
  signature: state.signature,
  socialReplies: state.socialReplies,
  socialReposts: state.socialReposts,
  socialLikes: state.socialLikes,
  socialViews: state.socialViews,
  socialMetricScale: state.socialMetricScale,
  theme: state.theme,
  ratio: state.ratio,
  exportMode: state.exportMode,
  fontScale: state.fontScale,
  lineHeightScale: state.lineHeightScale,
  imagePosition: state.imagePosition,
  imageAlignment: state.imageAlignment,
  imageScale: state.imageScale,
  visualStyle: state.visualStyle,
  canvasStyle: state.canvasStyle,
  sceneBackdrop: state.sceneBackdrop,
  sceneFocus: state.sceneFocus,
  sceneCardRatio: state.sceneCardRatio,
  sceneCardScale: state.sceneCardScale,
  sceneCardHeight: state.sceneCardHeight,
  sceneCardPadding: state.sceneCardPadding,
  sceneCardX: state.sceneCardX,
  sceneCardY: state.sceneCardY,
  sceneOverlay: state.sceneOverlay,
});

function normalizeBrandTemplate(value: BrandTemplate): BrandTemplate {
  const profile = value.profile as Partial<BrandProfile>;
  return {
    ...value,
    profile: {
      name: typeof profile.name === "string" ? profile.name : "",
      userId: typeof profile.userId === "string" ? profile.userId : "",
      showSignature: Boolean(profile.showSignature),
      signature: typeof profile.signature === "string" ? profile.signature : "",
      socialReplies: typeof profile.socialReplies === "string" ? profile.socialReplies.slice(0, 8) : "2",
      socialReposts: typeof profile.socialReposts === "string" ? profile.socialReposts.slice(0, 8) : "",
      socialLikes: typeof profile.socialLikes === "string" ? profile.socialLikes.slice(0, 8) : "5",
      socialViews: typeof profile.socialViews === "string" ? profile.socialViews.slice(0, 8) : "307",
      socialMetricScale: normalizeSocialMetricScale(profile.socialMetricScale),
      theme: profile.theme === "light" || profile.theme === "white" ? profile.theme : "dark",
      ratio: profile.ratio === "2:3" || profile.ratio === "9:16" ? profile.ratio : "3:4",
      exportMode: profile.exportMode === "douyin-cover" ? "douyin-cover" : "standard",
      fontScale: typeof profile.fontScale === "number" && Number.isFinite(profile.fontScale)
        ? Math.min(200, Math.max(0, Math.round(profile.fontScale)))
        : 100,
      lineHeightScale: typeof profile.lineHeightScale === "number" && Number.isFinite(profile.lineHeightScale)
        ? Math.min(160, Math.max(80, Math.round(profile.lineHeightScale)))
        : 100,
      imagePosition: profile.imagePosition === "above" ? "above" : "below",
      imageAlignment: profile.imageAlignment === "center" ? "center" : "left",
      imageScale: typeof profile.imageScale === "number" ? profile.imageScale : DEFAULT_IMAGE_SCALE,
      visualStyle: profile.visualStyle === "folio" ? "folio" : "default",
      canvasStyle: profile.canvasStyle === "scene" ? "scene" : "card",
      sceneBackdrop: normalizeSceneBackdrop(profile.sceneBackdrop),
      sceneFocus: profile.sceneFocus === "top" || profile.sceneFocus === "bottom" ? profile.sceneFocus : "center",
      sceneCardRatio:
        profile.sceneCardRatio === "1:1" || profile.sceneCardRatio === "3:4" || profile.sceneCardRatio === "4:3"
          ? profile.sceneCardRatio
          : "3:4",
      sceneCardScale: typeof profile.sceneCardScale === "number" ? Math.min(100, Math.max(70, profile.sceneCardScale)) : 100,
      sceneCardHeight: typeof profile.sceneCardHeight === "number"
        ? Math.min(SCENE_CARD_HEIGHT_MAX, Math.max(SCENE_CARD_HEIGHT_MIN, Math.round(profile.sceneCardHeight)))
        : DEFAULT_SCENE_CARD_HEIGHT,
      sceneCardPadding: typeof profile.sceneCardPadding === "number"
        ? Math.min(SCENE_CARD_PADDING_MAX, Math.max(SCENE_CARD_PADDING_MIN, Math.round(profile.sceneCardPadding)))
        : DEFAULT_SCENE_CARD_PADDING,
      sceneCardX: typeof profile.sceneCardX === "number" ? Math.min(95, Math.max(5, profile.sceneCardX)) : 50,
      sceneCardY: typeof profile.sceneCardY === "number" ? Math.min(95, Math.max(5, profile.sceneCardY)) : 50,
      sceneOverlay: typeof profile.sceneOverlay === "number" ? Math.min(70, Math.max(0, profile.sceneOverlay)) : 32,
    },
  };
}

export const createBrandTemplate = (state: BymarkState, avatar: string | null, title?: string): BrandTemplate => {
  const now = new Date().toISOString();
  return {
    id: makeId(),
    title: title?.trim() || `${state.name.trim() || "未命名"} · ${themeLabel(state.theme)}`,
    profile: brandProfileFor(state),
    avatar,
    createdAt: now,
    updatedAt: now,
  };
};

async function readBrandTemplates(name = DATABASE) {
  const database = await openDatabase(name);
  return new Promise<BrandTemplate[]>((resolve, reject) => {
    const request = database.transaction(STORE, "readonly").objectStore(STORE).getAll();
    request.onsuccess = () => {
      database.close();
      resolve((request.result as BrandTemplate[]).map(normalizeBrandTemplate).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("Unable to load brand templates"));
    };
  });
}

export async function loadBrandTemplates() {
  if (isSharedStorageEnabled()) {
    return (await loadSharedValue('brandTemplates')).map(normalizeBrandTemplate).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  const templates = await readBrandTemplates();
  if (templates.length) return templates;

  const legacyTemplates = await readBrandTemplates(LEGACY_DATABASE);
  if (!legacyTemplates.length) return legacyTemplates;

  await Promise.all(legacyTemplates.map(saveBrandTemplate));
  return legacyTemplates;
}

export async function saveBrandTemplate(template: BrandTemplate) {
  if (isSharedStorageEnabled()) {
    await saveSharedValue('brandTemplates', JSON.parse(JSON.stringify(template)), template.id);
    return;
  }
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE, "readwrite").objectStore(STORE).put(template);
    request.onsuccess = () => {
      database.close();
      resolve();
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("Unable to save brand template"));
    };
  });
}

export async function removeBrandTemplate(id: string) {
  if (isSharedStorageEnabled()) {
    await removeSharedValue('brandTemplates', id);
    return;
  }
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
    request.onsuccess = () => {
      database.close();
      resolve();
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("Unable to delete brand template"));
    };
  });
}
