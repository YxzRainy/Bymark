import { normalizeState, resolvedTitleFor, type BymarkState } from "./bymark";
import { isSharedStorageEnabled, loadSharedValue, removeSharedValue, saveSharedValue } from './sharedStorage.ts';

export interface Archive {
  id: string;
  title: string;
  /** The original Markdown is the canonical archived content. */
  markdown: string;
  state: BymarkState;
  createdAt: string;
  archivedAt: string;
}

const ARCHIVE_DB_NAME = "bymark-archives";
const ARCHIVE_STORE_NAME = "archives";

function createId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cloneState(state: BymarkState): BymarkState {
  return { ...state };
}

function normalizeArchive(value: Partial<Archive>): Archive {
  const archivedAt = typeof value.archivedAt === "string" ? value.archivedAt : new Date().toISOString();
  const storedState = normalizeState(value.state ?? { text: value.markdown ?? "", title: value.title ?? "" });
  const markdown = typeof value.markdown === "string" ? value.markdown : storedState.text;
  const state = { ...storedState, text: markdown };
  return {
    id: typeof value.id === "string" ? value.id : createId(),
    title: typeof value.title === "string" && value.title.trim() ? value.title : resolvedTitleFor(state),
    markdown,
    state,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : archivedAt,
    archivedAt,
  };
}

function openArchiveDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const request = indexedDB.open(ARCHIVE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ARCHIVE_STORE_NAME)) {
        database.createObjectStore(ARCHIVE_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open archive storage"));
  });
}

function sortArchives(archives: Archive[]) {
  return [...archives].sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
}

export function createArchive(state: BymarkState, createdAt = new Date().toISOString()): Archive {
  const archivedAt = new Date().toISOString();
  const snapshot = cloneState(state);
  return {
    id: createId(),
    title: resolvedTitleFor(snapshot),
    markdown: snapshot.text,
    state: snapshot,
    createdAt,
    archivedAt,
  };
}

export function archiveMarkdown(archive: Archive) {
  const escapeFrontmatter = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    "---",
    `title: "${escapeFrontmatter(archive.title)}"`,
    `author: "${escapeFrontmatter(archive.state.name)}"`,
    `archived_at: "${archive.archivedAt}"`,
    "---",
    "",
    archive.markdown.trim(),
    "",
  ].join("\n");
}

export function archiveJson(archive: Archive) {
  return JSON.stringify({
    format: "bymark-archive",
    version: 1,
    id: archive.id,
    title: archive.title,
    markdown: archive.markdown,
    metadata: {
      author: archive.state.name,
      handle: archive.state.userId,
      createdAt: archive.createdAt,
      archivedAt: archive.archivedAt,
    },
  }, null, 2);
}

export function archiveCollectionMarkdown(archives: Archive[]) {
  return archives.map((archive) => [
    `# ${archive.title}`,
    "",
    archive.markdown.trim(),
  ].join("\n")).join("\n\n---\n\n") + "\n";
}

export async function loadArchives() {
  if (isSharedStorageEnabled()) {
    return sortArchives((await loadSharedValue('archives')).map(normalizeArchive));
  }
  const database = await openArchiveDatabase();
  return new Promise<Archive[]>((resolve, reject) => {
    const request = database.transaction(ARCHIVE_STORE_NAME, "readonly").objectStore(ARCHIVE_STORE_NAME).getAll();
    request.onsuccess = () => {
      database.close();
      resolve(sortArchives((request.result as Partial<Archive>[]).map(normalizeArchive)));
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("Unable to load archives"));
    };
  });
}

export async function saveArchive(archive: Archive) {
  if (isSharedStorageEnabled()) {
    await saveSharedValue('archives', JSON.parse(JSON.stringify(archive)), archive.id);
    return;
  }
  const database = await openArchiveDatabase();
  return new Promise<void>((resolve, reject) => {
    const stored = JSON.parse(JSON.stringify(archive)) as Archive;
    const request = database.transaction(ARCHIVE_STORE_NAME, "readwrite").objectStore(ARCHIVE_STORE_NAME).put(stored);
    request.onsuccess = () => {
      database.close();
      resolve();
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("Unable to save archive"));
    };
  });
}

export async function removeArchive(id: string) {
  if (isSharedStorageEnabled()) {
    await removeSharedValue('archives', id);
    return;
  }
  const database = await openArchiveDatabase();
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(ARCHIVE_STORE_NAME, "readwrite").objectStore(ARCHIVE_STORE_NAME).delete(id);
    request.onsuccess = () => {
      database.close();
      resolve();
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("Unable to delete archive"));
    };
  });
}
