import type { BrandTemplate } from "./brandTemplates";
import type { Draft } from "./drafts";
import type { Archive } from "./archives";
import type { BymarkState } from "./bymark";
import { normalizeSceneBackdrop } from "./sceneBackdrops.ts";
import { normalizeSocialMetricScale } from './socialMetrics.ts';

export const WORKSPACE_FORMAT = "bymark-workspace" as const;
export const WORKSPACE_VERSION = 2 as const;

export interface WorkspaceExport {
  format: typeof WORKSPACE_FORMAT;
  version: typeof WORKSPACE_VERSION;
  exportedAt: string;
  state: BymarkState;
  avatar: string | null;
  image: string | null;
  sceneImage: string | null;
  drafts: Draft[];
  archives: Archive[];
  brandTemplates: BrandTemplate[];
}

type LegacyPublishDetails = {
  showSeries?: boolean;
  series?: string;
  showEngagement?: boolean;
  likes?: string;
  comments?: string;
  saves?: string;
};

function stripLegacyPublishDetails(value: BymarkState & LegacyPublishDetails): BymarkState {
  const state = { ...value };
  delete state.showSeries;
  delete state.series;
  delete state.showEngagement;
  delete state.likes;
  delete state.comments;
  delete state.saves;
  return state;
}

export function createWorkspaceExport(input: Omit<WorkspaceExport, "format" | "version" | "exportedAt">): WorkspaceExport {
  return { format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION, exportedAt: new Date().toISOString(), ...input };
}

export function parseWorkspaceExport(value: unknown): WorkspaceExport {
  if (!value || typeof value !== "object") throw new Error("工作区文件不是有效对象");
  const data = value as Omit<Partial<WorkspaceExport>, "version"> & { version?: number };
  if (data.format !== WORKSPACE_FORMAT || (data.version !== 1 && data.version !== WORKSPACE_VERSION)) throw new Error("工作区文件版本不受支持");
  if (!data.state || typeof data.state !== "object" || !Array.isArray(data.drafts) || !Array.isArray(data.brandTemplates)) {
    throw new Error("工作区文件缺少必要数据");
  }
  return {
    format: WORKSPACE_FORMAT,
    version: WORKSPACE_VERSION,
    exportedAt: typeof data.exportedAt === "string" ? data.exportedAt : new Date().toISOString(),
    state: {
      ...stripLegacyPublishDetails(data.state as BymarkState & LegacyPublishDetails),
      visualStyle: data.state.visualStyle === "folio" ? "folio" : "default",
      sceneBackdrop: normalizeSceneBackdrop(data.state.sceneBackdrop),
      socialReplies: typeof data.state.socialReplies === "string" ? data.state.socialReplies.slice(0, 8) : "2",
      socialReposts: typeof data.state.socialReposts === "string" ? data.state.socialReposts.slice(0, 8) : "",
      socialLikes: typeof data.state.socialLikes === "string" ? data.state.socialLikes.slice(0, 8) : "5",
      socialViews: typeof data.state.socialViews === "string" ? data.state.socialViews.slice(0, 8) : "307",
      socialMetricScale: normalizeSocialMetricScale(data.state.socialMetricScale),
    },
    avatar: typeof data.avatar === "string" ? data.avatar : null,
    image: typeof data.image === "string" ? data.image : null,
    sceneImage: typeof data.sceneImage === "string" ? data.sceneImage : null,
    drafts: data.drafts as Draft[],
    archives: Array.isArray(data.archives) ? data.archives as Archive[] : [],
    brandTemplates: data.brandTemplates as BrandTemplate[],
  };
}

export function mergeById<T extends { id: string; updatedAt?: string }>(local: T[], incoming: T[]) {
  const merged = new Map(local.map((item) => [item.id, item]));
  incoming.forEach((item) => {
    const current = merged.get(item.id);
    // Legacy records lack timestamps; retain the previous incoming-wins behavior for them.
    if (!current || !current.updatedAt || !item.updatedAt || item.updatedAt >= current.updatedAt) merged.set(item.id, item);
  });
  return Array.from(merged.values());
}
