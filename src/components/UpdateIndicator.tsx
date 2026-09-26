import { ArrowUpRight } from "lucide-vue-next";
import { defineComponent } from "vue";
import { useVersionCheck } from "../composables/useVersionCheck";

export const UpdateIndicator = defineComponent(() => {
  const { update } = useVersionCheck();
  return () => {
    if (!update.value) return null;

    return (
      <a
        class="version-update-indicator"
        href={update.value.url}
        target="_blank"
        rel="noreferrer"
        title={`当前 v${update.value.currentVersion}，最新 v${update.value.version}`}
        aria-label={`发现 Bymark 新版本 ${update.value.version}，当前版本 ${update.value.currentVersion}，前往 GitHub 查看更新`}
      >
        <span class="version-update-dot" aria-hidden="true" />
        <span class="version-update-label">更新</span>
        <ArrowUpRight class="version-update-arrow" size={12} aria-hidden="true" />
      </a>
    );
  };
});
