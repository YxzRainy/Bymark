import {
  FilePlus2,
  CopyPlus,
  Download,
  PanelRightClose,
  PanelRightOpen,
  PanelLeftOpen,
  ChevronLeft,
  X,
  RotateCcw,
  Upload,
} from "lucide-vue-next";
import { defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Draft, DraftDropPlacement } from "../drafts";
import { DraftList } from "./DraftList";

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export const DraftLibrary = defineComponent((props: {
  drafts: Draft[];
  activeDraftId: string | null;
  loading: boolean;
  busy: boolean;
  hasText: boolean;
  dirty: boolean;
  savedAt: string | null;
  onStartFresh: () => void;
  onStartNextIssue: () => void;
  onUseDraft: (id: string) => void;
  onRenameDraft: (id: string, title: string) => void;
  onDeleteDraft: (id: string) => void;
  onReorderDraft: (sourceId: string, targetId: string, placement: DraftDropPlacement) => void;
  onResetInitialization: () => void;
  onBackupWorkspace: () => void;
  onRestoreWorkspace: (file: File) => void;
  workspacePending: boolean;
}) => {
  const collapsed = ref(false);
  const mobileOpen = ref(false);
  const mobileTriggerExpanded = ref(false);
  const workspaceInputRef = ref<HTMLInputElement | null>(null);
  const closeMobileDrawer = () => {
    mobileOpen.value = false;
  };
  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (mobileOpen.value) closeMobileDrawer();
    else mobileTriggerExpanded.value = false;
  };
  const collapseMobileTriggerOnOutsideClick = (event: MouseEvent) => {
    if (!mobileTriggerExpanded.value) return;
    if (event.target instanceof Element && event.target.closest(".draft-mobile-trigger")) return;
    mobileTriggerExpanded.value = false;
  };
  watch(mobileOpen, (open) => document.documentElement.classList.toggle("draft-drawer-open", open));
  onMounted(() => {
    document.addEventListener("keydown", handleKeydown);
    document.addEventListener("click", collapseMobileTriggerOnOutsideClick);
  });
  onBeforeUnmount(() => {
    document.removeEventListener("keydown", handleKeydown);
    document.removeEventListener("click", collapseMobileTriggerOnOutsideClick);
    document.documentElement.classList.remove("draft-drawer-open");
  });
  return () => (
    <>
      <button
        type="button"
        class={["draft-mobile-trigger", mobileTriggerExpanded.value && "draft-mobile-trigger-expanded", mobileOpen.value && "draft-mobile-trigger-open"]}
        aria-label={mobileTriggerExpanded.value ? "打开草稿抽屉" : "展开草稿入口"}
        aria-controls="draft-library"
        aria-expanded={mobileOpen.value}
        onClick={() => {
          if (!mobileTriggerExpanded.value) {
            mobileTriggerExpanded.value = true;
            return;
          }
          collapsed.value = false;
          mobileOpen.value = true;
        }}
      >
        <PanelLeftOpen size={18} />
        <span class="draft-mobile-trigger-details" aria-hidden={!mobileTriggerExpanded.value}>
          <span>草稿</span>
          {props.drafts.length > 0 && <em>{props.drafts.length}</em>}
        </span>
      </button>
      <button
        type="button"
        class={["draft-mobile-backdrop", mobileOpen.value && "draft-mobile-backdrop-visible"]}
        aria-label="关闭草稿抽屉"
        tabindex={mobileOpen.value ? 0 : -1}
        onClick={closeMobileDrawer}
      />
      <aside id="draft-library" class={["draft-library", collapsed.value && "draft-library-collapsed", mobileOpen.value && "draft-library-mobile-open"]} aria-label="本地草稿">
      <div class="draft-library-header">
        <div class="draft-library-heading">
          <span>草稿</span>
          {props.drafts.length > 0 && <em>{props.drafts.length}</em>}
          {!collapsed.value && props.activeDraftId && (
            <small
              class={props.dirty ? "draft-status draft-status-dirty" : "draft-status"}
              title={props.savedAt ? `上次保存于 ${formatUpdatedAt(props.savedAt)}` : undefined}
            >
              {props.dirty ? "有修改" : "已保存"}
            </small>
          )}
        </div>
        <div class="draft-library-header-actions">
          <button
            type="button"
            class="draft-new-button icon-tooltip"
            onClick={() => {
              props.onStartFresh();
              closeMobileDrawer();
            }}
            aria-label="新建草稿"
            data-tooltip="新建草稿"
            disabled={props.loading || props.busy}
          >
            <FilePlus2 size={15} />
          </button>
          <button type="button" class="draft-icon-button draft-reset-button icon-tooltip" aria-label="恢复初始化配置" data-tooltip="恢复初始化配置" onClick={() => { props.onResetInitialization(); closeMobileDrawer(); }} disabled={props.loading || props.busy}><RotateCcw size={14} /></button>
          <a
            class="draft-github-link icon-tooltip"
            data-social="github"
            data-tooltip="GitHub"
            aria-label="在 GitHub 查看 Bymark 项目"
            href="https://github.com/YxzRainy/Bymark"
            target="_blank"
            rel="noreferrer"
          >
            <svg
              viewBox="0 0 16 16"
              class="bi bi-github"
              fill="currentColor"
              height="16"
              width="16"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                fill="currentColor"
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8"
              />
            </svg>
          </a>
          <button type="button" class="draft-mobile-close-button" aria-label="关闭草稿抽屉" title="关闭草稿抽屉" onClick={closeMobileDrawer}><X size={17} /></button>
          <button
            type="button"
            class="draft-collapse-button icon-tooltip"
            onClick={() => (collapsed.value = !collapsed.value)}
            aria-label={collapsed.value ? "展开草稿" : "收起草稿"}
            data-tooltip={collapsed.value ? "展开草稿" : "收起草稿"}
          >
            {collapsed.value ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
          </button>
        </div>
      </div>

      {!collapsed.value && (
        <>
          <div class="draft-library-toolbar">
            <div class="draft-autosave-status">
              <span class="draft-autosave-dot" aria-hidden="true" />
              <span>{props.activeDraftId ? (props.dirty ? "正在自动保存" : "本地自动保存") : props.hasText ? "输入后自动保存" : "本地自动保存"}</span>
              {props.savedAt && !props.dirty && <time datetime={props.savedAt}>· {formatUpdatedAt(props.savedAt)}</time>}
            </div>
            <button
              type="button"
              class="draft-save-button"
              onClick={() => {
                props.onStartNextIssue();
                closeMobileDrawer();
              }}
              disabled={props.loading || props.busy || !props.hasText}
              title="保留作者与版式，创建一张新的空白草稿"
            >
              <CopyPlus size={14} /> 下一期
            </button>
          </div>
          {props.loading ? (
            <p class="draft-library-empty">正在读取草稿…</p>
          ) : props.drafts.length === 0 ? (
            <div class="draft-library-empty draft-library-empty-card">
              <strong>还没有草稿</strong>
              <p>开始输入后，会自动保存在这里。</p>
            </div>
          ) : (
            <DraftList
              drafts={props.drafts}
              activeDraftId={props.activeDraftId}
              busy={props.busy}
              onUseDraft={(id) => {
                props.onUseDraft(id);
                closeMobileDrawer();
              }}
              onRenameDraft={props.onRenameDraft}
              onDeleteDraft={props.onDeleteDraft}
              onReorderDraft={props.onReorderDraft}
            />
          )}
          <div class="workspace-tools" aria-label="工作区备份">
            <div class="workspace-summary">
              <strong>工作区</strong>
              <span>草稿、预设与当前作品</span>
            </div>
            <button
              type="button"
              class="draft-mobile-footer-close"
              aria-label="关闭草稿抽屉"
              title="关闭草稿抽屉"
              onClick={closeMobileDrawer}
            >
              <ChevronLeft size={20} />
            </button>
            <input
              ref={workspaceInputRef}
              type="file"
              accept="application/json,.json"
              class="sr-only"
              aria-label="选择工作区备份文件"
              onChange={(event) => {
                const input = event.target as HTMLInputElement;
                const file = input.files?.[0];
                if (file) props.onRestoreWorkspace(file);
                input.value = "";
              }}
            />
            <button
              type="button"
              class="workspace-action-tooltip workspace-backup-tooltip icon-tooltip"
              aria-label="备份工作区：导出草稿、预设与当前作品"
              data-tooltip="导出草稿、预设与当前作品为备份文件，方便迁移或留存。"
              disabled={props.workspacePending}
              onClick={props.onBackupWorkspace}
            >
              <Download size={14} /> 备份
            </button>
            <button
              type="button"
              class="workspace-action-tooltip workspace-restore-tooltip icon-tooltip"
              aria-label="恢复工作区：导入备份中的草稿、预设与当前作品"
              data-tooltip="导入备份中的草稿、预设与当前作品；同名数据会以较新的版本为准。"
              disabled={props.workspacePending}
              onClick={() => workspaceInputRef.value?.click()}
            >
              <Upload size={14} /> 恢复
            </button>
          </div>
        </>
      )}
      </aside>
    </>
  );
}, {
  props: [
    "drafts",
    "activeDraftId",
    "loading",
    "busy",
    "hasText",
    "dirty",
    "savedAt",
    "onStartFresh",
    "onStartNextIssue",
    "onUseDraft",
    "onRenameDraft",
    "onDeleteDraft",
    "onReorderDraft",
    "onResetInitialization",
    "onBackupWorkspace",
    "onRestoreWorkspace",
    "workspacePending",
  ],
});
