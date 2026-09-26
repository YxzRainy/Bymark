import { onMounted, readonly, shallowRef } from "vue";
import packageJson from "../../package.json";
import { fetchRemoteVersion, resolveVersionUpdate, type RemoteVersion, type VersionUpdate } from "../version";

const CHECK_INTERVAL = 4 * 60 * 60 * 1000;
const REQUEST_TIMEOUT = 7000;
const CACHE_KEY = `bymark-version-check-v1:${packageJson.version}`;

const update = shallowRef<VersionUpdate | null>(null);
const checking = shallowRef(false);
let cacheInitialized = false;
let hasFreshCache = false;

type CachedVersion = RemoteVersion & {
  checkedAt: number;
};

function readCache(): CachedVersion | null {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as Partial<CachedVersion> | null;
    if (
      !value
      || typeof value.checkedAt !== "number"
      || Date.now() - value.checkedAt >= CHECK_INTERVAL
      || typeof value.version !== "string"
      || typeof value.url !== "string"
      || (value.source !== "release" && value.source !== "repository")
    ) return null;
    return value as CachedVersion;
  } catch {
    return null;
  }
}

function writeCache(remote: RemoteVersion) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...remote, checkedAt: Date.now() } satisfies CachedVersion));
  } catch {
    // Version checks are optional and must never affect the local-first app.
  }
}

export function useVersionCheck() {
  if (!cacheInitialized) {
    cacheInitialized = true;
    const cached = typeof localStorage === "undefined" ? null : readCache();
    hasFreshCache = Boolean(cached);
    update.value = cached ? resolveVersionUpdate(packageJson.version, cached) : null;
  }

  const check = async () => {
    if (hasFreshCache || checking.value) return;
    checking.value = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const remote = await fetchRemoteVersion(fetch, controller.signal);
      if (!remote) return;
      writeCache(remote);
      hasFreshCache = true;
      update.value = resolveVersionUpdate(packageJson.version, remote);
    } finally {
      window.clearTimeout(timeout);
      checking.value = false;
    }
  };

  onMounted(() => void check());

  return {
    currentVersion: packageJson.version,
    update: readonly(update),
    checking: readonly(checking),
    check,
  };
}
