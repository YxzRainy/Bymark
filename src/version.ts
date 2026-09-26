export const BYMARK_REPOSITORY_URL = "https://github.com/YxzRainy/Bymark";

const LATEST_RELEASE_API = "https://api.github.com/repos/YxzRainy/Bymark/releases/latest";
const REPOSITORY_PACKAGE_URL = "https://raw.githubusercontent.com/YxzRainy/Bymark/main/package.json";

type ParsedVersion = {
  core: [number, number, number];
  prerelease: Array<number | string>;
};

export type RemoteVersion = {
  version: string;
  url: string;
  source: "release" | "repository";
};

export type VersionUpdate = RemoteVersion & {
  currentVersion: string;
};

function parseVersion(value: string): ParsedVersion | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;

  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]
      ? match[4].split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part)
      : [],
  };
}

/** Returns a positive number when `left` is newer than `right`. */
export function compareVersions(left: string, right: string): number | null {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) return null;

  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const difference = leftVersion.core[index] - rightVersion.core[index];
    if (difference !== 0) return difference;
  }

  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length > 0) return 1;
  if (leftVersion.prerelease.length > 0 && rightVersion.prerelease.length === 0) return -1;

  const identifierCount = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    if (typeof leftIdentifier === "number" && typeof rightIdentifier === "string") return -1;
    if (typeof leftIdentifier === "string" && typeof rightIdentifier === "number") return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }

  return 0;
}

export function resolveVersionUpdate(currentVersion: string, remote: RemoteVersion): VersionUpdate | null {
  const comparison = compareVersions(remote.version, currentVersion);
  return comparison !== null && comparison > 0 ? { ...remote, currentVersion } : null;
}

async function readJson(fetcher: typeof fetch, url: string, signal?: AbortSignal) {
  try {
    const response = await fetcher(url, {
      headers: { Accept: "application/vnd.github+json" },
      signal,
    });
    return response.ok ? await response.json() as unknown : null;
  } catch {
    return null;
  }
}

export async function fetchRemoteVersion(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<RemoteVersion | null> {
  const release = await readJson(fetcher, LATEST_RELEASE_API, signal) as { tag_name?: unknown; html_url?: unknown } | null;
  if (typeof release?.tag_name === "string" && parseVersion(release.tag_name)) {
    return {
      version: release.tag_name.replace(/^v/i, ""),
      url: typeof release.html_url === "string" ? release.html_url : `${BYMARK_REPOSITORY_URL}/releases/latest`,
      source: "release",
    };
  }

  // The project may not have published its first GitHub Release yet. In that
  // case package.json on main remains the canonical, lightweight fallback.
  const packageJson = await readJson(fetcher, REPOSITORY_PACKAGE_URL, signal) as { version?: unknown } | null;
  if (typeof packageJson?.version !== "string" || !parseVersion(packageJson.version)) return null;
  return {
    version: packageJson.version.replace(/^v/i, ""),
    url: BYMARK_REPOSITORY_URL,
    source: "repository",
  };
}
