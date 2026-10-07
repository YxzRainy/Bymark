import { toCanvas } from "html-to-image";
import { zip } from "fflate";
import { Eye, PenLine } from "lucide-vue-next";
import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, Transition, watch } from "vue";
import {
  createBrandTemplate,
  loadBrandTemplates,
  removeBrandTemplate,
  saveBrandTemplate,
  type BrandTemplate,
} from "./brandTemplates";
import { EditorPanel } from "./components/EditorPanel";
import type { ExportButtonStatus } from "./components/ExportButton";
import { PostCard } from "./components/PostCard";
import { PreviewStage } from "./components/PreviewStage";
import type { ExportFormat, ExportResolution } from "./exportOptions";
import {
  createDraft,
  createSnapshot,
  loadDrafts,
  removeDraft,
  reorderDrafts,
  saveDraft,
  sortDrafts,
  snapshotsMatch,
  updateDraftSnapshot,
  type Draft,
} from "./drafts";
import { DraftLibrary } from "./components/DraftLibrary";
import { archiveCollectionMarkdown, createArchive, loadArchives, removeArchive, saveArchive, type Archive } from "./archives";
import { ArchiveLibrary } from "./components/ArchiveLibrary";
import { ThemeToggle } from "./components/ThemeToggle";
import {
  DEFAULT_AVATAR,
  DEFAULT_EXPORT_SETTINGS,
  createDefaultState,
  currentLocalValues,
  filenameFor,
  loadAvatar,
  loadState,
  normalizeState,
  normalizeWorkTitle,
  RATIO_HEIGHTS,
  saveAvatar,
  saveState,
  IMAGE_ASSET_KEY,
  SCENE_IMAGE_ASSET_KEY,
  loadImageAsset,
  saveImageAsset,
  type BymarkState,
} from "./bymark";
import { ensureSrgbPng } from "./png";
import { createNextIssueState } from "./nextIssue";
import { IMAGE_SCALE_MAX, IMAGE_SCALE_MIN } from "./imageScale";
import { PAGE_BREAK_MARKER, paginateMarkdownDetailed, setManualBreakBefore, type PaginatedPage } from "./pagination";
import { createWorkspaceExport, mergeById, parseWorkspaceExport } from "./workspace";
import { UpdateIndicator } from "./components/UpdateIndicator";
import { isSharedStorageEnabled, saveSharedValue, sharedInitialValue } from './sharedStorage.ts';

export type { ExportFormat, ExportResolution } from "./exportOptions";
type Notice = {
  tone: "success" | "error";
  message: string;
  action?: { label: string; onClick: () => void };
} | null;

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const RATIO_PARTS = {
  "3:4": [3, 4],
  "2:3": [2, 3],
  "9:16": [9, 16],
} as const satisfies Record<keyof typeof RATIO_HEIGHTS, readonly [number, number]>;

let exportStyleProperties: string[] | undefined;

export function stylePropertiesForExport() {
  if (!exportStyleProperties) {
    // html-to-image subtracts 0.1px when it copies the font-size longhand.
    // Copying the computed font shorthand preserves the preview's exact text metrics.
    exportStyleProperties = Array.from(getComputedStyle(document.documentElement)).map((property) =>
      property === "font-size" ? "font" : property,
    );
  }
  return exportStyleProperties;
}


/**
 * 等待指定元素内的所有图片加载完成
 * @param element 要检查的根元素
 * @returns Promise，所有图片加载完成后 resolve
 */
function waitForImages(element: HTMLElement): Promise<void> {
  const images = Array.from(element.querySelectorAll('img'));

  if (images.length === 0) {
    return Promise.resolve();
  }

  const imagePromises = images.map((img) => {
    // 如果图片已经加载完成
    if (img.complete && img.naturalHeight !== 0) {
      return Promise.resolve();
    }

    // 否则等待加载完成或失败
    return new Promise<void>((resolve) => {
      const onLoad = () => {
        cleanup();
        resolve();
      };

      const onError = () => {
        cleanup();
        // 图片加载失败也要继续，避免阻塞导出
        console.warn('Image failed to load:', img.src);
        resolve();
      };

      const cleanup = () => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
      };

      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);

      // 设置超时，避免无限等待
      setTimeout(() => {
        cleanup();
        console.warn('Image loading timeout:', img.src);
        resolve();
      }, 10000); // 10秒超时
    });
  });

  return Promise.all(imagePromises).then(() => {});
}

export function exportDimensions(resolution: ExportResolution, ratio: keyof typeof RATIO_HEIGHTS) {
  const [widthPart, heightPart] = RATIO_PARTS[ratio];
  return { width: Math.round(resolution * widthPart / heightPart), height: resolution };
}

export function estimateExportSize(resolution: ExportResolution, ratio: keyof typeof RATIO_HEIGHTS, format: ExportFormat) {
  const { width, height } = exportDimensions(resolution, ratio);
  // These are deliberately conservative ballpark figures. Actual PNG size depends on text and uploaded imagery.
  const bytesPerPixel = format === "png" ? 0.54 : 0.2;
  return { width, height, estimate: formatBytes(width * height * bytesPerPixel), scale: height / RATIO_HEIGHTS[ratio] };
}

function extensionFor(format: ExportFormat) {
  return format === "jpg" ? "jpg" : "png";
}

function exportFilename(state: BymarkState, format: ExportFormat, resolution: ExportResolution) {
  return filenameFor(state).replace(/\.png$/, `-${resolution / 1024}k.${extensionFor(format)}`);
}

const EXPORT_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
} as const satisfies Record<ExportFormat, string>;

const EXPORT_SIGNATURE = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpg: [0xff, 0xd8, 0xff],
} as const satisfies Record<ExportFormat, readonly number[]>;
const EXPORT_PREFERENCES_KEY = "bymark-export-preferences-v1";

function loadExportPreferences(): { format: ExportFormat; resolution: ExportResolution } {
  try {
    const value = isSharedStorageEnabled()
      ? sharedInitialValue('exportPreferences')
      : JSON.parse(localStorage.getItem(EXPORT_PREFERENCES_KEY) ?? "null") as Partial<{ format: ExportFormat; resolution: ExportResolution }> | null;
    return {
      format: value?.format === "jpg" ? "jpg" : DEFAULT_EXPORT_SETTINGS.format,
      resolution: [1024, 2048, 3072, 4096].includes(value?.resolution as number) ? value!.resolution as ExportResolution : DEFAULT_EXPORT_SETTINGS.resolution,
    };
  } catch {
    return { ...DEFAULT_EXPORT_SETTINGS };
  }
}

function saveExportPreferences(format: ExportFormat, resolution: ExportResolution) {
  try { localStorage.setItem(EXPORT_PREFERENCES_KEY, JSON.stringify({ format, resolution })); } catch { /* optional preference */ }
  if (isSharedStorageEnabled()) void saveSharedValue('exportPreferences', { format, resolution }).catch(console.error);
}

function encodeCanvas(canvas: HTMLCanvasElement, format: ExportFormat) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Canvas image encoding failed")),
      EXPORT_MIME[format],
      format === "jpg" ? 0.94 : undefined,
    );
  });
}

async function verifyExportBlob(blob: Blob, format: ExportFormat) {
  const expectedMime = EXPORT_MIME[format];
  const expectedSignature = EXPORT_SIGNATURE[format];
  const signature = new Uint8Array(await blob.slice(0, expectedSignature.length).arrayBuffer());
  const hasExpectedSignature = expectedSignature.every((byte, index) => signature[index] === byte);
  if (blob.type !== expectedMime || !hasExpectedSignature) {
    throw new Error(`Unexpected export encoding: expected ${expectedMime}, received ${blob.type || "unknown"}`);
  }
}

export default defineComponent(() => {
  const state = ref<BymarkState>(loadState());
  const avatar = ref<string | null>(DEFAULT_AVATAR);
  const avatarReady = ref(false);
  const image = ref<string | null>(null);
  const imageScaleMax = shallowRef(IMAGE_SCALE_MAX);
  const sceneImage = ref<string | null>(null);
  const exporting = ref(false);
  const exportProgress = shallowRef(0);
  const exportStatus = shallowRef<ExportButtonStatus>("idle");
  const overflowing = ref(false);
  const notice = ref<Notice>(null);
  const drafts = ref<Draft[]>([]);
  const draftsLoading = ref(true);
  const archives = ref<Archive[]>([]);
  const archivesLoading = ref(true);
  const archiveActionPending = ref(false);
  const archiveOpen = ref(false);
  const activeDraftId = ref<string | null>(null);
  const draftActionPending = ref(false);
  const draftSavedAt = ref<string | null>(null);
  const brandTemplates = ref<BrandTemplate[]>([]);
  const templatesLoading = ref(true);
  const templatePending = ref(false);
  const mobileMode = ref<"editor" | "preview">("editor");
  const workspaceTransition = ref<"editor" | "preview" | null>(null);
  const exportCardElement = ref<HTMLDivElement | null>(null);
  const exportPageIndex = ref<number | null>(null);
  const exportPageOverflowing = ref(false);
  const exportPreferences = loadExportPreferences();
  const exportFormat = ref<ExportFormat>(exportPreferences.format);
  const exportResolution = ref<ExportResolution>(exportPreferences.resolution);
  const historyResetToken = ref(0);
  const activePageIndex = ref(0);
  const workspacePending = ref(false);
  // The text paginator starts with its calibrated estimate. If the rendered
  // card still reports clipping, this scale is reduced until the overflowing
  // page is split. Keeping this feedback outside the renderer preserves a
  // single source of truth for the page list.
  const paginationCapacityScale = shallowRef(1);
  const estimatedPages = computed(() => paginateMarkdownDetailed(state.value.text, {
    ratio: state.value.ratio,
    exportMode: state.value.exportMode,
    fontScale: state.value.fontScale,
    lineHeightScale: state.value.lineHeightScale,
    visualStyle: state.value.visualStyle,
    canvasStyle: state.value.canvasStyle,
    sceneCardRatio: state.value.sceneCardRatio,
    sceneCardHeight: state.value.sceneCardHeight,
    capacityScale: paginationCapacityScale.value,
    hasImage: Boolean(image.value),
  }));
  const measuredPages = ref<PaginatedPage[] | null>(null);
  const pages = computed(() => measuredPages.value ?? estimatedPages.value);
  const paginationProbe = ref<{ text: string; pageIndex: number } | null>(null);
  const previewFrozenState = shallowRef<BymarkState | null>(null);
  const previewState = computed(() => previewFrozenState.value ?? state.value);
  let avatarLoadVersion = 0;
  let draftActionInFlight = false;
  let autoSaveTimer: number | undefined;
  let noticeTimer: number | undefined;
  let exportCompletionTimer: number | undefined;
  let exportDialogTimer: number | undefined;
  let paginationMeasurementTimer: number | undefined;
  let paginationMeasurementVersion = 0;
  let workspaceTransitionTimer: number | undefined;
  let applyingSnapshot = false;
  let avatarSaveQueue = Promise.resolve();
  let deletedDraft: { draft: Draft; wasActive: boolean } | null = null;

  const layoutKeys = new Set<keyof BymarkState>([
    "ratio",
    "exportMode",
    "fontScale",
    "lineHeightScale",
    "visualStyle",
    "canvasStyle",
    "sceneCardRatio",
    "sceneCardHeight",
    "sceneCardPadding",
  ]);
  const update = <K extends keyof BymarkState>(key: K, value: BymarkState[K]) => {
    // Text pagination is verified against the rendered card asynchronously.
    // Retain the last confirmed state and page list during that short pass so
    // inserting a page break cannot flash the estimate (or a blank page).
    if (key === "text" && measuredPages.value && !previewFrozenState.value)
      previewFrozenState.value = state.value;
    else if (layoutKeys.has(key) && state.value[key] !== value && measuredPages.value)
      previewFrozenState.value = state.value;
    state.value = { ...state.value, [key]: value };
  };
  const updateImageScaleMax = (limit: number) => {
    const nextLimit = Math.min(IMAGE_SCALE_MAX, Math.max(IMAGE_SCALE_MIN, Math.floor(limit)));
    imageScaleMax.value = nextLimit;
    if (state.value.imageScale > nextLimit) update("imageScale", nextLimit);
  };
  const updateOverflow = (value: boolean) => {
    if (!value) {
      overflowing.value = false;
      return;
    }

    const previousPageCount = pages.value.length;
    const previousPageText = pages.value[activePageIndex.value]?.text;
    let nextScale = paginationCapacityScale.value;

    // A single adjustment may keep the same page boundary. Step down until
    // the current page actually changes, then let PostCard measure it again.
    while (nextScale > 0.35) {
      nextScale = Math.max(0.35, Math.round((nextScale - 0.08) * 100) / 100);
      paginationCapacityScale.value = nextScale;
      if (
        pages.value.length !== previousPageCount ||
        pages.value[activePageIndex.value]?.text !== previousPageText
      ) {
        overflowing.value = false;
        return;
      }
    }

    overflowing.value = true;
  };
  const syncVisualViewport = () => {
    const viewport = window.visualViewport;
    document.documentElement.style.setProperty("--bymark-visual-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
    document.documentElement.style.setProperty("--bymark-visual-viewport-top", `${viewport?.offsetTop ?? 0}px`);
  };
  const switchWorkspace = (mode: "editor" | "preview") => {
    if (mobileMode.value === mode) return;
    mobileMode.value = mode;
    workspaceTransition.value = mode;
    if (workspaceTransitionTimer) window.clearTimeout(workspaceTransitionTimer);
    workspaceTransitionTimer = window.setTimeout(() => (workspaceTransition.value = null), 280);
  };
  const updateAvatar = (value: string | null) => {
    avatarLoadVersion += 1;
    avatar.value = value;
    avatarReady.value = true;
  };
  const queueAvatarSave = (value: string | null) => {
    // IndexedDB writes may finish out of order when an avatar is quickly
    // replaced or removed. Keep them ordered so an older image cannot return
    // after a later delete on the next app load.
    avatarSaveQueue = avatarSaveQueue.catch(() => undefined).then(() => saveAvatar(value)).catch(() => {
      notice.value = { tone: "error", message: "头像无法保存到本地，请稍后重试。" };
    });
  };
  let imageSaveQueue = Promise.resolve();
  const queueImageSave = (key: string, value: string | null) => {
    imageSaveQueue = imageSaveQueue.catch(() => undefined).then(() => saveImageAsset(key, value)).catch(() => {
      const message = `${key === SCENE_IMAGE_ASSET_KEY ? "场景背景" : "配图"}无法保存到本地，请稍后重试。`;
      notice.value = { tone: "error", message };
      throw new Error(message);
    });
    return imageSaveQueue;
  };
  const currentSnapshot = () => createSnapshot(state.value, avatar.value, image.value, sceneImage.value);
  const currentDraft = () => activeDraftId.value ? drafts.value.find((draft) => draft.id === activeDraftId.value) ?? null : null;
  const isDraftDirty = () => {
    const draft = currentDraft();
    return draft ? !snapshotsMatch(draft, currentSnapshot()) : Boolean(state.value.title.trim() || state.value.text.trim());
  };
  const persistDraft = async (draft: Draft) => {
    // New drafts must precede manually ordered entries, including after reload.
    if (draft.sortOrder === undefined && !drafts.value.some((item) => item.id === draft.id)) {
      const firstOrder = drafts.value.reduce((first, item) => Math.min(first, item.sortOrder ?? Infinity), Infinity);
      if (Number.isFinite(firstOrder)) draft = { ...draft, sortOrder: firstOrder - 1 };
    }
    await saveDraft(draft);
    drafts.value = sortDrafts([...drafts.value.filter((item) => item.id !== draft.id), draft]);
    draftSavedAt.value = draft.updatedAt;
  };
  const runDraftAction = async (action: () => Promise<void>) => {
    if (draftActionInFlight) return;
    draftActionInFlight = true;
    draftActionPending.value = true;
    try {
      await action();
    } finally {
      draftActionInFlight = false;
      draftActionPending.value = false;
    }
  };
  const saveActiveDraftSnapshot = async (showNotice = false) => {
    const draft = currentDraft();
    if (draft && !isDraftDirty()) return draft;
    if (!draft && !state.value.title.trim() && !state.value.text.trim()) return null;
    const next = draft
      ? updateDraftSnapshot(draft, state.value, avatar.value, image.value, sceneImage.value)
      : createDraft(state.value, avatar.value, image.value, sceneImage.value);
    await persistDraft(next);
    activeDraftId.value = next.id;
    if (showNotice) notice.value = { tone: "success", message: "已保存完整卡片快照。" };
    return next;
  };
  const scheduleAutoSave = () => {
    if (applyingSnapshot || draftsLoading.value || !isDraftDirty()) return;
    if (autoSaveTimer) window.clearTimeout(autoSaveTimer);
    autoSaveTimer = window.setTimeout(() => {
      autoSaveTimer = undefined;
      saveActiveDraftSnapshot().catch(() => {
        notice.value = { tone: "error", message: "自动保存失败，请稍后重试。" };
      });
    }, 800);
  };
  const applySnapshot = (snapshot: { state: BymarkState; avatar: string | null; image: string | null; sceneImage: string | null }) => {
    applyingSnapshot = true;
    if (autoSaveTimer) window.clearTimeout(autoSaveTimer);
    state.value = { ...snapshot.state };
    avatarLoadVersion += 1;
    avatar.value = snapshot.avatar;
    avatarReady.value = true;
    image.value = snapshot.image;
    sceneImage.value = snapshot.sceneImage;
    activePageIndex.value = 0;
    historyResetToken.value += 1;
    window.setTimeout(() => (applyingSnapshot = false), 0);
  };
  const stashCurrentCard = async () => {
    if (!state.value.title.trim() && !state.value.text.trim()) return null;
    const active = currentDraft();
    if (active) return saveActiveDraftSnapshot();
    const snapshot = currentSnapshot();
    const matching = drafts.value.find((draft) => snapshotsMatch(draft, snapshot));
    if (matching) return matching;
    const draft = createDraft(state.value, avatar.value, image.value, sceneImage.value);
    await persistDraft(draft);
    return draft;
  };
  const startFreshDraft = () => runDraftAction(async () => {
    try {
      await stashCurrentCard();
      applyingSnapshot = true;
      const freshTimestamp = currentLocalValues();
      state.value = { ...state.value, ...freshTimestamp, title: "", text: "" };
      image.value = null;
      exportFormat.value = "png";
      exportResolution.value = 2048;
      activePageIndex.value = 0;
      activeDraftId.value = null;
      historyResetToken.value += 1;
      window.setTimeout(() => (applyingSnapshot = false), 0);
      notice.value = { tone: "success", message: "已新建空白草稿。" };
    } catch {
      notice.value = { tone: "error", message: "当前卡片未能自动暂存。" };
    }
  });
  const startNextIssue = () => runDraftAction(async () => {
    try {
      await stashCurrentCard();
      const nextState = createNextIssueState(state.value, currentLocalValues());
      const nextDraft = createDraft(nextState, avatar.value, null, null);
      await persistDraft(nextDraft);
      applySnapshot(nextDraft);
      activeDraftId.value = nextDraft.id;
      notice.value = { tone: "success", message: "已创建下一期。" };
    } catch {
      notice.value = { tone: "error", message: "下一期创建失败，请稍后重试。" };
    }
  });
  const useDraft = (id: string) => runDraftAction(async () => {
    const next = drafts.value.find((draft) => draft.id === id);
    if (!next) return;
    try {
      await stashCurrentCard();
      applySnapshot(next);
      activeDraftId.value = next.id;
      notice.value = { tone: "success", message: `已恢复完整草稿「${next.title}」。` };
    } catch {
      notice.value = { tone: "error", message: "当前卡片未能自动暂存。" };
    }
  });
  const renameDraft = (id: string, title: string) => runDraftAction(async () => {
    const draft = drafts.value.find((item) => item.id === id);
    if (!draft) return;
    const normalizedTitle = normalizeWorkTitle(title);
    const isActive = activeDraftId.value === id;
    if (isActive) applyingSnapshot = true;
    try {
      const nextState = isActive
        ? { ...state.value, title: normalizedTitle }
        : { ...draft.state, title: normalizedTitle };
      if (isActive) state.value = nextState;
      const nextDraft = updateDraftSnapshot(
        draft,
        nextState,
        isActive ? avatar.value : draft.avatar,
        isActive ? image.value : draft.image,
        isActive ? sceneImage.value : draft.sceneImage,
      );
      await persistDraft(nextDraft);
    } catch {
      notice.value = { tone: "error", message: "草稿重命名失败，请稍后重试。" };
    } finally {
      if (isActive) {
        window.setTimeout(() => {
          applyingSnapshot = false;
          scheduleAutoSave();
        }, 0);
      }
    }
  });
  const undoDeleteDraft = () => runDraftAction(async () => {
    if (!deletedDraft) return;
    const deleted = deletedDraft;
    deletedDraft = null;
    await persistDraft(deleted.draft);
    if (deleted.wasActive) {
      applySnapshot(deleted.draft);
      activeDraftId.value = deleted.draft.id;
    }
    notice.value = { tone: "success", message: "草稿已恢复。" };
  });
  const deleteDraft = (id: string) => runDraftAction(async () => {
    const draft = drafts.value.find((item) => item.id === id);
    if (!draft) return;
    try {
      const wasActive = activeDraftId.value === id;
      await removeDraft(id);
      drafts.value = drafts.value.filter((item) => item.id !== id);
      if (wasActive) {
        // 编辑器里还留着被删草稿的内容，不清空会在切换草稿时
        // 被 stashCurrentCard 重新存成新草稿，看起来像"删除后自动恢复"。
        applyingSnapshot = true;
        state.value = { ...state.value, title: "", text: "" };
        image.value = null;
        sceneImage.value = null;
        activeDraftId.value = null;
        draftSavedAt.value = null;
        activePageIndex.value = 0;
        historyResetToken.value += 1;
        window.setTimeout(() => (applyingSnapshot = false), 0);
      }
      deletedDraft = { draft, wasActive };
      notice.value = { tone: "success", message: "草稿已移除。可在几秒内撤销。", action: { label: "撤销", onClick: undoDeleteDraft } };
    } catch {
      notice.value = { tone: "error", message: "草稿删除失败，请稍后重试。" };
    }
  });
  const reorderDraftList = (sourceId: string, targetId: string, placement: "before" | "after") => runDraftAction(async () => {
    const next = reorderDrafts(drafts.value, sourceId, targetId, placement);
    if (next === drafts.value) return;
    try {
      await Promise.all(next.map(saveDraft));
      drafts.value = next;
    } catch {
      notice.value = { tone: "error", message: "草稿顺序保存失败，请稍后重试。" };
    }
  });
  const archiveCurrentWork = () => runDraftAction(async () => {
    if (!state.value.title.trim() && !state.value.text.trim()) {
      notice.value = { tone: "error", message: "写下内容后才能归档。" };
      return;
    }
    try {
      const archived = createArchive(state.value, currentDraft()?.createdAt);
      await saveArchive(archived);
      archives.value = [archived, ...archives.value];
      const active = currentDraft();
      if (active) {
        await removeDraft(active.id);
        drafts.value = drafts.value.filter((draft) => draft.id !== active.id);
      }
      applyingSnapshot = true;
      state.value = { ...state.value, ...currentLocalValues(), title: "", text: "" };
      image.value = null;
      sceneImage.value = null;
      activeDraftId.value = null;
      draftSavedAt.value = null;
      activePageIndex.value = 0;
      historyResetToken.value += 1;
      archiveOpen.value = true;
      window.setTimeout(() => (applyingSnapshot = false), 0);
      notice.value = { tone: "success", message: `已归档「${archived.title}」。` };
    } catch (error) {
      console.error(error);
      notice.value = { tone: "error", message: "归档失败，请稍后重试。" };
    }
  });
  const exportAllArchives = () => {
    if (archives.value.length === 0) return;
    const filename = `bymark-archives-${currentLocalValues().date}.md`;
    downloadBlob(new Blob([archiveCollectionMarkdown(archives.value)], { type: "text/markdown;charset=utf-8" }), filename);
    notice.value = { tone: "success", message: `已导出全部 ${archives.value.length} 篇归档。` };
  };
  const deleteArchive = async (id: string) => {
    if (archiveActionPending.value) return;
    const archive = archives.value.find((item) => item.id === id);
    if (!archive) return;
    archiveActionPending.value = true;
    try {
      await removeArchive(id);
      archives.value = archives.value.filter((item) => item.id !== id);
      notice.value = { tone: "success", message: `已删除归档「${archive.title}」。` };
    } catch {
      notice.value = { tone: "error", message: "归档删除失败，请稍后重试。" };
    } finally {
      archiveActionPending.value = false;
    }
  };
  const saveBrand = async (title: string) => {
    templatePending.value = true;
    try {
      const template = createBrandTemplate(state.value, avatar.value, title);
      await saveBrandTemplate(template);
      brandTemplates.value = [template, ...brandTemplates.value];
      notice.value = { tone: "success", message: `已保存设置预设「${template.title}」。` };
    } catch {
      notice.value = { tone: "error", message: "设置预设保存失败，请稍后重试。" };
    } finally {
      templatePending.value = false;
    }
  };
  const useBrand = (id: string) => {
    const template = brandTemplates.value.find((item) => item.id === id);
    if (!template) return;
    applyingSnapshot = true;
    state.value = { ...state.value, ...template.profile };
    avatarLoadVersion += 1;
    avatar.value = template.avatar;
    avatarReady.value = true;
    window.setTimeout(() => {
      applyingSnapshot = false;
      scheduleAutoSave();
    }, 0);
    notice.value = { tone: "success", message: `已应用设置预设「${template.title}」。` };
  };
  const deleteBrand = async (id: string) => {
    templatePending.value = true;
    try {
      await removeBrandTemplate(id);
      brandTemplates.value = brandTemplates.value.filter((item) => item.id !== id);
      notice.value = { tone: "success", message: "设置预设已删除。" };
    } catch {
      notice.value = { tone: "error", message: "设置预设删除失败，请稍后重试。" };
    } finally {
      templatePending.value = false;
    }
  };
  const readImage = async (file: File, setter: (value: string | null) => void | Promise<void>) => {
    try {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        throw new Error("仅支持 JPG、PNG 或 WebP 图片。");
      }
      if (file.size > 15 * 1024 * 1024) throw new Error("图片不能超过 15 MB。");
      const source = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error("图片读取失败，请重新选择。"));
        reader.onerror = () => reject(new Error("图片读取失败，请重新选择。"));
        reader.onabort = () => reject(new Error("图片读取已取消，请重新选择。"));
        reader.readAsDataURL(file);
      });
      const imageElement = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => element.naturalWidth && element.naturalHeight
          ? resolve(element)
          : reject(new Error("图片尺寸读取失败，请重新选择。"));
        element.onerror = () => reject(new Error("图片尺寸读取失败，请重新选择。"));
        element.src = source;
      });
      const maxDimension = 4096;
      const longest = Math.max(imageElement.naturalWidth, imageElement.naturalHeight);
      if (longest <= maxDimension) {
        await setter(source);
        return;
      }
      const scale = maxDimension / longest;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(imageElement.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(imageElement.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("图片尺寸过大且无法压缩，请换一张图片。");
      context.drawImage(imageElement, 0, 0, canvas.width, canvas.height);
      await setter(canvas.toDataURL(file.type, 0.92));
    } catch (error) {
      notice.value = { tone: "error", message: error instanceof Error ? error.message : "图片处理失败，请重新选择。" };
      throw error;
    }
  };
  const applyImageFile = (file: File) => readImage(file, async (value) => {
    const unchanged = image.value === value;
    image.value = value;
    // The synchronous image watcher queues the durable asset write before
    // this await. A crop is complete only when both copies have been saved.
    // A retry may produce identical pixels, so queue it explicitly when Vue
    // would otherwise skip the watcher for an unchanged data URL.
    await (unchanged ? queueImageSave(IMAGE_ASSET_KEY, value) : imageSaveQueue);
    if (autoSaveTimer) {
      window.clearTimeout(autoSaveTimer);
      autoSaveTimer = undefined;
    }
    try {
      await saveActiveDraftSnapshot();
    } catch {
      throw new Error("配图无法保存到草稿，请稍后重试。");
    }
  });
  const resetInitialization = () => runDraftAction(async () => {
    if (autoSaveTimer) window.clearTimeout(autoSaveTimer);
    applyingSnapshot = true;
    state.value = createDefaultState();
    avatarLoadVersion += 1;
    avatar.value = DEFAULT_AVATAR;
    avatarReady.value = true;
    image.value = null;
    sceneImage.value = null;
    activePageIndex.value = 0;
    activeDraftId.value = null;
    draftSavedAt.value = null;
    exportFormat.value = DEFAULT_EXPORT_SETTINGS.format;
    exportResolution.value = DEFAULT_EXPORT_SETTINGS.resolution;
    saveExportPreferences(DEFAULT_EXPORT_SETTINGS.format, DEFAULT_EXPORT_SETTINGS.resolution);
    historyResetToken.value += 1;
    await saveAvatar(DEFAULT_AVATAR);
    window.setTimeout(() => (applyingSnapshot = false), 0);
    // 重置后的内容立即落为新草稿，让右侧草稿列表直接出现，
    // 不需要用户再点一次草稿才能看到。
    try {
      await saveActiveDraftSnapshot();
    } catch {
      notice.value = { tone: "error", message: "重置内容未能保存为草稿，请稍后重试。" };
      return;
    }
    notice.value = { tone: "success", message: "当前作品已恢复为项目初始化配置。" };
  });
  const waitForRenderedPage = async () => {
    await nextTick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  };
  const probePageFits = async (text: string, pageIndex: number, version: number) => {
    paginationProbe.value = { text, pageIndex };
    await waitForRenderedPage();
    if (version !== paginationMeasurementVersion) return null;
    const copy = document.querySelector<HTMLElement>("[data-pagination-probe] .post-copy");
    if (!copy) return null;
    return copy.scrollHeight <= copy.clientHeight + 1 && copy.scrollWidth <= copy.clientWidth + 1;
  };
  const lastMeasuredBreak = async (source: string, start: number, pageIndex: number, version: number) => {
    const breakpoints: number[] = [];
    for (let index = start + 1; index < source.length; index += 1) {
      const previous = source[index - 1] ?? "";
      // CJK 文本允许在任意字符间断行，否则无标点长文会退化成逐字测页。
      if (/[。！？；.!?;，,、：:\n\s]/u.test(previous) || /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(previous)) {
        breakpoints.push(index);
      }
    }
    if (breakpoints.at(-1) !== source.length) breakpoints.push(source.length);

    let low = 0;
    let high = breakpoints.length - 1;
    let result = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const fits = await probePageFits(source.slice(start, breakpoints[middle]), pageIndex, version);
      if (fits === null) return null;
      if (fits) {
        result = breakpoints[middle];
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    // A single unbroken token can still be wider than a card. Preserve it
    // rather than looping forever; the visible card will flag that case.
    return result > start ? result : Math.min(source.length, start + 1);
  };
  const measurePagination = async (version: number) => {
    const source = state.value.text.replace(/\r\n?/g, "\n");
    const sections = source.split(PAGE_BREAK_MARKER);
    const resolved: PaginatedPage[] = [];
    let sectionOffset = 0;

    for (const [sectionIndex, section] of sections.entries()) {
      let cursor = 0;
      let sectionPage = 0;
      if (!section) {
        resolved.push({
          text: "",
          fillRatio: 0,
          manualBreakBefore: sectionIndex > 0,
          sectionIndex,
          sourceOffset: sectionOffset,
        });
      }
      while (cursor < section.length) {
        const pageIndex = resolved.length;
        const remainder = section.slice(cursor);
        const wholePageFits = await probePageFits(remainder, pageIndex, version);
        if (wholePageFits === null) return;
        const end = wholePageFits
          ? section.length
          : await lastMeasuredBreak(section, cursor, pageIndex, version);
        if (end === null || version !== paginationMeasurementVersion) return;
        const pageStart = cursor;
        const pageText = section.slice(pageStart, end);
        cursor = end;
        // A manual page marker is surrounded by line breaks. Around a tight
        // measured break those characters can be selected as a page on their
        // own, producing a blank preview and moving the manual marker one
        // page later. Whitespace is never meaningful page content: skip it
        // and keep the manual marker for the next real page.
        if (!pageText.trim()) continue;
        resolved.push({
          text: pageText,
          fillRatio: 0,
          manualBreakBefore: sectionIndex > 0 && sectionPage === 0,
          sectionIndex,
          sourceOffset: sectionOffset + pageStart,
        });
        sectionPage += 1;
      }
      sectionOffset += section.length + (sectionIndex < sections.length - 1 ? PAGE_BREAK_MARKER.length : 0);
    }

    if (version === paginationMeasurementVersion) {
      measuredPages.value = resolved.length ? resolved : [{
        text: "",
        fillRatio: 0,
        manualBreakBefore: false,
        sectionIndex: 0,
        sourceOffset: 0,
      }];
      previewFrozenState.value = null;
      paginationProbe.value = null;
    }
  };
  const scheduleMeasuredPagination = (keepCurrentPages = false) => {
    paginationMeasurementVersion += 1;
    if (!keepCurrentPages) measuredPages.value = null;
    if (paginationMeasurementTimer) window.clearTimeout(paginationMeasurementTimer);
    const version = paginationMeasurementVersion;
    paginationMeasurementTimer = window.setTimeout(() => {
      paginationMeasurementTimer = undefined;
      void measurePagination(version);
    }, 40);
  };
  const makeExport = async (node: HTMLDivElement) => {
    // Wait for the export-only desktop canvas to finish loading and measuring.
    await Promise.all([
      document.fonts.ready,
      waitForImages(node)
    ]);
    await waitForRenderedPage();
    if (exportPageOverflowing.value) throw new Error("Export page is overflowing");
    const dimensions = exportDimensions(exportResolution.value, state.value.ratio);
    const baseWidth = 800;
    const baseHeight = RATIO_HEIGHTS[state.value.ratio];
    // 使用 pixelRatio 缩放，确保预览和导出的布局完全一致
    const scale = dimensions.height / baseHeight;
    const options = {
      cacheBust: true,
      pixelRatio: scale,
      width: baseWidth,
      height: baseHeight,
      backgroundColor: state.value.theme === "dark" ? "#151617" : "#ffffff",
      includeStyleProperties: stylePropertiesForExport(),
    };
    const format = exportFormat.value;
    const canvas = await toCanvas(node, options);
    const encoded = await encodeCanvas(canvas, format);
    const blob = format === "png" ? await ensureSrgbPng(encoded) : encoded;
    await verifyExportBlob(blob, format);
    return blob;
  };
  const renderExportPage = async (pageIndex: number) => {
    exportPageOverflowing.value = false;
    exportPageIndex.value = pageIndex;
    await waitForRenderedPage();
    const node = exportCardElement.value;
    if (!node) throw new Error("Desktop export card not ready");
    return makeExport(node);
  };
  const guardExport = () => {
    if (overflowing.value) {
      notice.value = { tone: "error", message: "当前页内容过密，请调整后再导出。" };
      return false;
    }
    return true;
  };
  const pageFilename = (pageIndex: number, totalPages: number) => {
    const filename = exportFilename(state.value, exportFormat.value, exportResolution.value);
    if (totalPages === 1) return filename;
    const extension = `.${extensionFor(exportFormat.value)}`;
    return filename.replace(extension, `-${String(pageIndex + 1).padStart(2, "0")}${extension}`);
  };
  const renderAllPages = async () => {
    const files: Array<{ name: string; blob: Blob }> = [];
    const totalPages = pages.value.length;
    try {
      for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
        exportProgress.value = Math.max(exportProgress.value, 6 + (pageIndex / totalPages) * 76);
        files.push({ name: pageFilename(pageIndex, pages.value.length), blob: await renderExportPage(pageIndex) });
        exportProgress.value = 6 + ((pageIndex + 1) / totalPages) * 76;
      }
      return files;
    } finally {
      exportPageIndex.value = null;
    }
  };
  const downloadBlob = (blob: Blob, name: string) => {
    const link = document.createElement("a");
    link.download = name;
    link.href = URL.createObjectURL(blob);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
  };
  const createZip = async (files: Array<{ name: string; blob: Blob }>) => {
    const entries: Record<string, Uint8Array> = {};
    await Promise.all(files.map(async ({ name, blob }) => {
      entries[name] = new Uint8Array(await blob.arrayBuffer());
    }));
    return new Promise<Blob>((resolve, reject) => {
      zip(entries, { level: 0 }, (error, data) => {
        if (error) reject(error);
        else resolve(new Blob([data], { type: "application/zip" }));
      });
    });
  };
  const downloadExports = async (files: Array<{ name: string; blob: Blob }>) => {
    if (files.length === 1) {
      exportProgress.value = 91;
      downloadBlob(files[0].blob, files[0].name);
      exportProgress.value = 98;
      return files[0].blob.size;
    }
    exportProgress.value = 88;
    const archive = await createZip(files);
    exportProgress.value = 96;
    const archiveName = pageFilename(0, 1).replace(/\.(png|jpg)$/i, `-${files.length}-pages.zip`);
    downloadBlob(archive, archiveName);
    exportProgress.value = 98;
    return archive.size;
  };
  const requestImageExport = (useCurrentTime: boolean) => {
    if (exporting.value || exportStatus.value !== "idle" || !guardExport()) return;
    exportStatus.value = "preparing";
    exportDialogTimer = window.setTimeout(() => {
      exportStatus.value = "idle";
      void exportImage(useCurrentTime);
      exportDialogTimer = undefined;
    }, 360);
  };
  const exportImage = async (useCurrentTime: boolean) => {
    if (exporting.value || !guardExport()) return;
    const savedState = state.value;
    const preserveDraft = applyingSnapshot;
    if (useCurrentTime) {
      // Current time is a one-export override: render it, then restore the editor exactly as it was.
      applyingSnapshot = true;
      state.value = { ...state.value, ...currentLocalValues() };
    }
    if (exportCompletionTimer) window.clearTimeout(exportCompletionTimer);
    exportProgress.value = 2;
    exportStatus.value = "exporting";
    exporting.value = true;
    try {
      const files = await renderAllPages();
      const size = await downloadExports(files);
      exportProgress.value = 100;
      exportStatus.value = "complete";
      exportCompletionTimer = window.setTimeout(() => {
        exportStatus.value = "idle";
        exportProgress.value = 0;
        exportCompletionTimer = undefined;
      }, 8_000);
      notice.value = { tone: "success", message: files.length > 1
        ? `已导出 ${files.length} 页 ZIP · ${formatBytes(size)}`
        : `已导出 ${files[0].name} · ${formatBytes(size)}` };
    } catch (error) {
      console.error(error);
      exportStatus.value = "idle";
      exportProgress.value = 0;
      notice.value = { tone: "error", message: "导出失败，请稍后重试。" };
    } finally {
      exporting.value = false;
      if (useCurrentTime) {
        state.value = savedState;
        await waitForRenderedPage();
        window.setTimeout(() => (applyingSnapshot = preserveDraft), 0);
      }
    }
  };
  const copyImage = async () => {
    if (exporting.value || !guardExport()) return;
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      notice.value = { tone: "error", message: "当前浏览器不支持复制图片，请使用下载导出。" };
      return;
    }
    exporting.value = true;
    try {
      const blob = await renderExportPage(activePageIndex.value);
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      notice.value = { tone: "success", message: `已复制 ${exportResolution.value / 1024}K ${exportFormat.value.toUpperCase()} 图片。` };
    } catch (error) {
      console.error(error);
      notice.value = { tone: "error", message: "复制失败，请检查浏览器剪贴板权限后重试。" };
    } finally {
      exportPageIndex.value = null;
      exporting.value = false;
    }
  };
  const backupWorkspace = async () => {
    if (workspacePending.value) return;
    workspacePending.value = true;
    try {
      await saveActiveDraftSnapshot();
      const payload = createWorkspaceExport({
        state: { ...state.value },
        avatar: avatar.value,
        image: image.value,
        sceneImage: sceneImage.value,
        drafts: drafts.value,
        archives: archives.value,
        brandTemplates: brandTemplates.value,
      });
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      downloadBlob(blob, `bymark-workspace-${currentLocalValues().date}.json`);
      notice.value = { tone: "success", message: `工作区已备份 · ${drafts.value.length} 个草稿` };
    } catch (error) {
      console.error(error);
      notice.value = { tone: "error", message: "工作区备份失败，请稍后重试。" };
    } finally {
      workspacePending.value = false;
    }
  };
  const restoreWorkspace = async (file: File) => {
    if (workspacePending.value) return;
    if (file.size > 80 * 1024 * 1024) {
      notice.value = { tone: "error", message: "工作区文件不能超过 80 MB。" };
      return;
    }
    workspacePending.value = true;
    try {
      const workspace = parseWorkspaceExport(JSON.parse(await file.text()));
      await stashCurrentCard();
      const mergedDrafts = mergeById(drafts.value, workspace.drafts);
      const mergedArchives = mergeById(archives.value, workspace.archives);
      const mergedTemplates = mergeById(brandTemplates.value, workspace.brandTemplates);
      await Promise.all([
        ...mergedDrafts.map(saveDraft),
        ...mergedArchives.map(saveArchive),
        ...mergedTemplates.map(saveBrandTemplate),
      ]);
      drafts.value = sortDrafts(await loadDrafts());
      archives.value = await loadArchives();
      brandTemplates.value = await loadBrandTemplates();
      const restoredState = normalizeState(workspace.state);
      applySnapshot({
        state: restoredState,
        avatar: workspace.avatar ?? DEFAULT_AVATAR,
        image: workspace.image,
        sceneImage: workspace.sceneImage,
      });
      activeDraftId.value = null;
      draftSavedAt.value = null;
      await saveAvatar(workspace.avatar ?? DEFAULT_AVATAR);
      notice.value = { tone: "success", message: `工作区已恢复 · ${drafts.value.length} 个草稿、${archives.value.length} 篇归档` };
    } catch (error) {
      console.error(error);
      notice.value = { tone: "error", message: "工作区文件无法恢复，请检查文件是否有效。" };
    } finally {
      workspacePending.value = false;
    }
  };

  onMounted(async () => {
    syncVisualViewport();
    scheduleMeasuredPagination();
    window.visualViewport?.addEventListener("resize", syncVisualViewport);
    window.visualViewport?.addEventListener("scroll", syncVisualViewport);
    window.addEventListener("resize", syncVisualViewport);
    saveState(state.value);
    const version = avatarLoadVersion;
    try {
      const storedAvatar = await loadAvatar();
      if (version === avatarLoadVersion) {
        avatar.value = storedAvatar ?? DEFAULT_AVATAR;
        avatarReady.value = true;
      }
    } catch {
      avatarReady.value = true;
    }
    try {
      const [storedImage, storedSceneImage] = await Promise.all([
        loadImageAsset(IMAGE_ASSET_KEY),
        loadImageAsset(SCENE_IMAGE_ASSET_KEY),
      ]);
      if (version === avatarLoadVersion) {
        image.value = storedImage;
        sceneImage.value = storedSceneImage;
      }
    } catch {
      // 恢复失败时保持空白，不影响正文。
    }
    try {
      const storedDrafts = await loadDrafts();
      const snapshot = currentSnapshot();
      const exactMatch = storedDrafts.find((draft) => snapshotsMatch(draft, snapshot));
      // 启动时图片来自独立资产库，快照匹配可能因图片差异失败，
      // 兜底只比较 state 和 avatar，避免每次刷新都新建草稿。
      const stateAvatarMatch = (draft: Draft) =>
        draft.avatar === avatar.value && JSON.stringify(draft.state) === JSON.stringify(state.value);
      const legacyTitleMatch = exactMatch || state.value.title.trim()
        ? null
        : storedDrafts.find((draft) => draft.titleLocked && draft.state.title.trim() && stateAvatarMatch(
          { ...draft, state: { ...draft.state, title: "" } },
        ));
      const matchingDraft = exactMatch ?? storedDrafts.find(stateAvatarMatch) ?? legacyTitleMatch ?? null;
      if (legacyTitleMatch) state.value = { ...state.value, title: legacyTitleMatch.state.title };
      if (matchingDraft) {
        // 修复前上传的图片只存在草稿里，资产库为空时从草稿回填，
        // watch 会自动把它写入资产库供下次刷新直接恢复。
        if (!image.value && matchingDraft.image) image.value = matchingDraft.image;
        if (!sceneImage.value && matchingDraft.sceneImage) sceneImage.value = matchingDraft.sceneImage;
      }
      const syncedDraft = matchingDraft ? updateDraftSnapshot(matchingDraft, state.value, avatar.value, image.value, sceneImage.value) : null;
      if (syncedDraft && syncedDraft !== matchingDraft) {
        await saveDraft(syncedDraft);
        drafts.value = sortDrafts(storedDrafts.map((draft) => draft.id === syncedDraft.id ? syncedDraft : draft));
      } else {
        drafts.value = storedDrafts;
      }
      activeDraftId.value = matchingDraft?.id ?? null;
      draftSavedAt.value = syncedDraft?.updatedAt ?? matchingDraft?.updatedAt ?? null;
    } catch {
      notice.value = { tone: "error", message: "本地草稿暂时无法读取。" };
    } finally {
      draftsLoading.value = false;
    }
    try {
      brandTemplates.value = await loadBrandTemplates();
    } catch {
      notice.value = { tone: "error", message: "设置预设暂时无法读取。" };
    } finally {
      templatesLoading.value = false;
    }
    try {
      archives.value = await loadArchives();
    } catch {
      notice.value = { tone: "error", message: "本地归档暂时无法读取。" };
    } finally {
      archivesLoading.value = false;
    }
  });
  onBeforeUnmount(() => {
    window.visualViewport?.removeEventListener("resize", syncVisualViewport);
    window.visualViewport?.removeEventListener("scroll", syncVisualViewport);
    window.removeEventListener("resize", syncVisualViewport);
    if (noticeTimer) window.clearTimeout(noticeTimer);
    if (exportCompletionTimer) window.clearTimeout(exportCompletionTimer);
    if (exportDialogTimer) window.clearTimeout(exportDialogTimer);
    if (paginationMeasurementTimer) window.clearTimeout(paginationMeasurementTimer);
    if (autoSaveTimer) window.clearTimeout(autoSaveTimer);
    if (workspaceTransitionTimer) window.clearTimeout(workspaceTransitionTimer);
  });
  // Persist in the same tick as the control change. Besides avoiding a lost
  // final edit when the page is refreshed immediately, this also makes every
  // geometry slider (including scene card height/position) true write-through
  // configuration instead of relying on the next Vue render cycle.
  watch(state, (next) => {
    saveState(next);
    document.documentElement.style.colorScheme = next.theme === "dark" ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next.theme === "dark" ? "#0b0c0d" : next.theme === "white" ? "#f4f5f6" : "#ece2d3");
  }, { deep: true, immediate: true, flush: "sync" });
  watch([avatar, avatarReady], () => {
    if (avatarReady.value) queueAvatarSave(avatar.value);
  });
  watch(image, (value) => { void queueImageSave(IMAGE_ASSET_KEY, value).catch(() => undefined); }, { flush: "sync" });
  watch(sceneImage, (value) => { void queueImageSave(SCENE_IMAGE_ASSET_KEY, value).catch(() => undefined); }, { flush: "sync" });
  watch([exportFormat, exportResolution], ([format, resolution]) => {
    saveExportPreferences(format, resolution);
  }, { flush: "sync" });
  watch([state, avatar, image, sceneImage], scheduleAutoSave, { deep: true });
  watch(image, () => (imageScaleMax.value = IMAGE_SCALE_MAX));
  watch(
    () => [
      state.value.text,
      state.value.ratio,
      state.value.exportMode,
      state.value.fontScale,
      state.value.lineHeightScale,
      state.value.visualStyle,
      state.value.canvasStyle,
      state.value.sceneCardRatio,
      state.value.sceneCardHeight,
      state.value.sceneCardPadding,
      state.value.imageScale,
      state.value.visualStyle === "folio" && state.value.canvasStyle === "scene" && image.value
        ? `${state.value.sceneCardScale}:${state.value.sceneCardY}` : null,
      // A replacement photo can have a different aspect ratio even when the
      // presence of an image is unchanged, altering the first page's capacity.
      image.value,
    ],
    (next, previous) => {
      paginationCapacityScale.value = 1;
      // A text edit made through update() freezes the old, already measured
      // preview. Keep its page list until the new measurement is complete,
      // then swap both state and pages together in measurePagination().
      scheduleMeasuredPagination(Boolean(previewFrozenState.value) || Boolean(previous && next[0] === previous[0]));
    },
  );
  watch(() => pages.value.length, (length) => {
    activePageIndex.value = Math.min(activePageIndex.value, Math.max(0, length - 1));
    overflowing.value = false;
  });
  watch(activePageIndex, () => (overflowing.value = false));
  watch(notice, (value) => {
    if (noticeTimer) window.clearTimeout(noticeTimer);
    if (value) noticeTimer = window.setTimeout(() => (notice.value = null), value.action ? 6500 : 3200);
  });

  return () => {
    const exportEstimate = estimateExportSize(exportResolution.value, state.value.ratio, exportFormat.value);
    const exportPage = exportPageIndex.value === null ? null : pages.value[exportPageIndex.value];
    return (
      <main class={[
        "app-shell",
        `ui-${state.value.theme}`,
        `mobile-mode-${mobileMode.value}`,
        workspaceTransition.value && `workspace-transition-${workspaceTransition.value}`,
      ]}
      >
        <header class="mobile-brand-lockup">
          <img class="mobile-brand-mark" src="/icon-192.png" width="32" height="32" alt="留印图标" />
          <div class="brand-copy">
            <h1>留印</h1>
            <UpdateIndicator />
          </div>
          <ThemeToggle theme={state.value.theme} onChange={(theme) => update("theme", theme)} />
        </header>
        <nav class="mobile-mode-switch" aria-label="移动端工作区">
          <button type="button" role="tab" aria-selected={mobileMode.value === "editor"} aria-controls="mobile-editor-panel" onClick={() => switchWorkspace("editor")}>
            <PenLine aria-hidden="true" /> 编辑
          </button>
          <button type="button" role="tab" aria-selected={mobileMode.value === "preview"} aria-controls="mobile-preview-panel" onClick={() => switchWorkspace("preview")}>
            <Eye aria-hidden="true" /> 预览
          </button>
        </nav>
        <EditorPanel
          state={state.value}
          update={update}
          avatar={avatar.value}
          image={image.value}
          imageScaleMax={imageScaleMax.value}
          sceneImage={sceneImage.value}
          onAvatarFile={(file) => readImage(file, updateAvatar)}
          onImageFile={applyImageFile}
          onSceneImageFile={(file) => readImage(file, (value) => { sceneImage.value = value; })}
          onRemoveAvatar={() => updateAvatar(DEFAULT_AVATAR)}
          onRemoveImage={() => (image.value = null)}
          onRemoveSceneImage={() => (sceneImage.value = null)}
          onCurrentTime={() => (state.value = { ...state.value, ...currentLocalValues() })}
          brandTemplates={brandTemplates.value}
          templatesLoading={templatesLoading.value}
          templatesPending={templatePending.value}
          onSaveBrand={saveBrand}
          onUseBrand={useBrand}
          onDeleteBrand={deleteBrand}
          exportFormat={exportFormat.value}
          exportResolution={exportResolution.value}
          exportEstimate={exportEstimate}
          onExportFormat={(value) => (exportFormat.value = value)}
          onExportResolution={(value) => (exportResolution.value = value)}
          onExport={requestImageExport}
          onArchive={archiveCurrentWork}
          onOpenArchive={() => (archiveOpen.value = true)}
          onCopyImage={copyImage}
          exporting={exporting.value}
          exportProgress={exportProgress.value}
          exportStatus={exportStatus.value}
          overflowing={overflowing.value}
          historyResetToken={historyResetToken.value}
          pageCount={pages.value.length}
        />
        <PreviewStage
          state={previewState.value}
          avatar={avatar.value}
          image={image.value}
          sceneImage={sceneImage.value}
          pages={pages.value}
          activePageIndex={activePageIndex.value}
          onPageChange={(index) => (activePageIndex.value = Math.max(0, Math.min(index, pages.value.length - 1)))}
          onRemoveManualBreak={(index) => {
            const page = pages.value[index];
            if (!page?.manualBreakBefore) return;
            update("text", setManualBreakBefore(state.value.text, page, false));
            activePageIndex.value = Math.max(0, index - 1);
            notice.value = { tone: "success", message: "已移除分页点，正文已自动续接。" };
          }}
          onSceneCardMove={(x, y) => {
            update("sceneCardX", x);
            update("sceneCardY", y);
          }}
          onImageScaleLimitChange={updateImageScaleMax}
          onCardRef={() => undefined}
          onOverflowChange={updateOverflow}
          overflowing={overflowing.value}
          onExport={() => requestImageExport(false)}
          onArchive={archiveCurrentWork}
          exporting={exporting.value}
          exportFormat={exportFormat.value}
        />
        {exporting.value && exportPage && (
          <div
            class="export-render-host"
            style={{ height: `${RATIO_HEIGHTS[state.value.ratio]}px` }}
            aria-hidden="true"
          >
            <PostCard
              renderMode="export"
              state={state.value}
              pageText={exportPage.text}
              avatar={avatar.value}
              image={exportPageIndex.value === 0 ? image.value : null}
              sceneImage={sceneImage.value}
              pageIndex={exportPageIndex.value ?? 0}
              totalPages={pages.value.length}
              onSceneCardMove={() => undefined}
              onImageScaleLimitChange={() => undefined}
              onOverflowChange={(value) => (exportPageOverflowing.value = value)}
              cardRef={(node) => (exportCardElement.value = node)}
            />
          </div>
        )}
        {paginationProbe.value && (
          <div class="pagination-probe" aria-hidden="true">
            <PostCard
              renderMode="measure"
              state={state.value}
              pageText={paginationProbe.value.text}
              avatar={avatar.value}
              image={paginationProbe.value.pageIndex === 0 ? image.value : null}
              sceneImage={sceneImage.value}
              pageIndex={paginationProbe.value.pageIndex}
              totalPages={1}
              onSceneCardMove={() => undefined}
              onImageScaleLimitChange={() => undefined}
              onOverflowChange={() => undefined}
              cardRef={() => undefined}
            />
          </div>
        )}
        <DraftLibrary
          drafts={drafts.value}
          activeDraftId={activeDraftId.value}
          loading={draftsLoading.value}
          busy={draftActionPending.value}
          hasText={Boolean(state.value.title.trim() || state.value.text.trim())}
          dirty={isDraftDirty()}
          savedAt={draftSavedAt.value}
          onStartFresh={startFreshDraft}
          onStartNextIssue={startNextIssue}
          onUseDraft={useDraft}
          onRenameDraft={renameDraft}
          onDeleteDraft={deleteDraft}
          onReorderDraft={reorderDraftList}
          onResetInitialization={resetInitialization}
          onBackupWorkspace={backupWorkspace}
          onRestoreWorkspace={restoreWorkspace}
          workspacePending={workspacePending.value}
        />
        <Transition name="archive-dialog" appear duration={220}>
          {archiveOpen.value && (
            <ArchiveLibrary
              archives={archives.value}
              theme={state.value.theme}
              loading={archivesLoading.value}
              busy={archiveActionPending.value}
              onClose={() => (archiveOpen.value = false)}
              onExportAll={exportAllArchives}
              onDeleteArchive={deleteArchive}
            />
          )}
        </Transition>
        {notice.value && (
          <div class={["toast", `toast-${notice.value.tone}`]} role="status">
            <span>{notice.value.message}</span>
            {notice.value.action && <button type="button" onClick={notice.value.action.onClick}>{notice.value.action.label}</button>}
          </div>
        )}
      </main>
    );
  };
});
