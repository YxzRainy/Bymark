import { normalizeState, normalizeWorkTitle, resolvedTitleFor, textTitleFor, type BymarkState } from "./bymark";
import { isSharedStorageEnabled, loadSharedValue, removeSharedValue, saveSharedValue } from './sharedStorage.ts';

export interface DraftSnapshot {
  state: BymarkState;
  avatar: string | null;
  image: string | null;
  sceneImage: string | null;
  savedAt: string;
}

export interface Draft extends DraftSnapshot {
  id: string;
  title: string;
  titleLocked?: boolean;
  /** A user-defined list position. Legacy drafts fall back to their last edit time. */
  sortOrder?: number;
  /** Retained for compact list rendering and migration from v1 drafts. */
  text: string;
  createdAt: string;
  updatedAt: string;
}

const DRAFT_DB_NAME = "bymark-drafts";
const LEGACY_DRAFT_DB_NAME = "postmark-drafts";
const DRAFT_STORE_NAME = "drafts";

function createId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cloneState(state: BymarkState): BymarkState {
  return { ...state };
}

function normalizeSnapshot(
  value: Partial<DraftSnapshot> | undefined,
  fallbackText: string,
  savedAt: string,
  legacyTitle = "",
): DraftSnapshot {
  const storedState: Partial<BymarkState> = value?.state ?? {};
  const state = normalizeState({
    ...storedState,
    title: typeof storedState.title === "string" ? storedState.title : legacyTitle,
    text: storedState.text ?? fallbackText,
  });
  return {
    state,
    avatar: typeof value?.avatar === "string" ? value.avatar : null,
    image: typeof value?.image === "string" ? value.image : null,
    sceneImage: typeof value?.sceneImage === "string" ? value.sceneImage : null,
    savedAt: typeof value?.savedAt === "string" ? value.savedAt : savedAt,
  };
}

function normalizeDraft(value: Partial<Draft>): Draft {
  const now = typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString();
  const text = typeof value.text === "string" ? value.text : "";
  const legacyTitleLocked = value.titleLocked === true;
  const legacyTitle = legacyTitleLocked && typeof value.title === "string" ? value.title : "";
  const snapshot = normalizeSnapshot(value, text, now, legacyTitle);
  return {
    id: typeof value.id === "string" ? value.id : createId(),
    title: resolvedTitleFor(snapshot.state),
    titleLocked: legacyTitleLocked,
    sortOrder: typeof value.sortOrder === "number" && Number.isFinite(value.sortOrder) ? value.sortOrder : undefined,
    text: snapshot.state.text,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: now,
    ...snapshot,
  };
}

function openDraftDatabase(name = DRAFT_DB_NAME) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const request = indexedDB.open(name, 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DRAFT_STORE_NAME)) {
        database.createObjectStore(DRAFT_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open draft storage"));
  });
}

export function sortDrafts(drafts: Draft[]) {
  return [...drafts].sort((left, right) => {
    const leftOrder = left.sortOrder;
    const rightOrder = right.sortOrder;
    if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder;
    if (leftOrder !== undefined) return -1;
    if (rightOrder !== undefined) return 1;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

export type DraftDropPlacement = "before" | "after";

/** Moves one draft relative to another and writes compact, stable positions. */
export function reorderDrafts(drafts: Draft[], sourceId: string, targetId: string, placement: DraftDropPlacement) {
  if (sourceId === targetId) return drafts;
  const source = drafts.find((draft) => draft.id === sourceId);
  const withoutSource = drafts.filter((draft) => draft.id !== sourceId);
  const targetIndex = withoutSource.findIndex((draft) => draft.id === targetId);
  if (!source || targetIndex === -1) return drafts;
  const insertAt = placement === "before" ? targetIndex : targetIndex + 1;
  const next = [...withoutSource.slice(0, insertAt), source, ...withoutSource.slice(insertAt)];
  return next.map((draft, sortOrder) => ({ ...draft, sortOrder }));
}

export function createSnapshot(state: BymarkState, avatar: string | null, image: string | null, sceneImage: string | null, savedAt = new Date().toISOString()): DraftSnapshot {
  return { state: cloneState(state), avatar, image, sceneImage, savedAt };
}

export function snapshotsMatch(left: DraftSnapshot, right: DraftSnapshot) {
  return left.avatar === right.avatar && left.image === right.image && left.sceneImage === right.sceneImage && JSON.stringify(left.state) === JSON.stringify(right.state);
}

export function createDraft(
  state: BymarkState,
  avatar: string | null,
  image: string | null,
  sceneImage: string | null,
  title?: string,
): Draft {
  const now = new Date().toISOString();
  const titledState = title === undefined
    ? cloneState(state)
    : { ...state, title: normalizeWorkTitle(title) };
  return {
    id: createId(),
    title: resolvedTitleFor(titledState),
    titleLocked: false,
    text: titledState.text,
    createdAt: now,
    updatedAt: now,
    ...createSnapshot(titledState, avatar, image, sceneImage, now),
  };
}

export function updateDraftSnapshot(draft: Draft, state: BymarkState, avatar: string | null, image: string | null, sceneImage: string | null): Draft {
  const next = createSnapshot(state, avatar, image, sceneImage);
  const title = resolvedTitleFor(state);
  if (snapshotsMatch(createSnapshot(draft.state, draft.avatar, draft.image, draft.sceneImage, draft.updatedAt), next) && draft.title === title) return draft;
  return {
    ...draft,
    ...next,
    title,
    titleLocked: false,
    text: state.text,
    updatedAt: next.savedAt,
  };
}

async function readDrafts(name = DRAFT_DB_NAME) {
  const database = await openDraftDatabase(name);
  return new Promise<Draft[]>((resolve, reject) => {
    const request = database.transaction(DRAFT_STORE_NAME, "readonly").objectStore(DRAFT_STORE_NAME).getAll();
    request.onsuccess = () => {
      database.close();
      resolve(sortDrafts((request.result as Partial<Draft>[]).map(normalizeDraft)));
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("Unable to load drafts"));
    };
  });
}

export async function loadDrafts() {
  if (isSharedStorageEnabled()) {
    return sortDrafts((await loadSharedValue('drafts')).map(normalizeDraft));
  }
  const drafts = await readDrafts();
  if (drafts.length) {
    // Rewrite legacy records once so hidden image-heavy version arrays are removed.
    await Promise.all(drafts.map(saveDraft)).catch(() => undefined);
    return drafts;
  }

  const legacyDrafts = await readDrafts(LEGACY_DRAFT_DB_NAME);
  if (!legacyDrafts.length) return legacyDrafts;

  await Promise.all(legacyDrafts.map(saveDraft));
  return legacyDrafts;
}

export async function saveDraft(draft: Draft) {
  if (isSharedStorageEnabled()) {
    await saveSharedValue('drafts', JSON.parse(JSON.stringify(draft)), draft.id);
    return;
  }
  const database = await openDraftDatabase();
  return new Promise<void>((resolve, reject) => {
    // Vue wraps entries read from a ref in proxies. IndexedDB cannot clone a
    // Proxy, so persist a plain data snapshot instead of the reactive object.
    const stored = JSON.parse(JSON.stringify(draft)) as Draft;
    const request = database.transaction(DRAFT_STORE_NAME, "readwrite").objectStore(DRAFT_STORE_NAME).put(stored);
    request.onsuccess = () => {
      database.close();
      resolve();
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("Unable to save draft"));
    };
  });
}

export async function removeDraft(id: string) {
  if (isSharedStorageEnabled()) {
    await removeSharedValue('drafts', id);
    return;
  }
  const database = await openDraftDatabase();
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(DRAFT_STORE_NAME, "readwrite").objectStore(DRAFT_STORE_NAME).delete(id);
    request.onsuccess = () => {
      database.close();
      resolve();
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("Unable to delete draft"));
    };
  });
}

export function draftTitleFor(text: string) {
  return textTitleFor(text);
}
