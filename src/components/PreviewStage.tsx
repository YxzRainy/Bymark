import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Download,
} from "lucide-vue-next";
import {
  computed,
  defineComponent,
  nextTick,
  Transition,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import type { BymarkState } from "../bymark";
import type { ExportFormat } from "../exportOptions";
import type { PaginatedPage } from "../pagination";
import { ASPECT_PRESETS, RATIO_HEIGHTS } from "../bymark";
import { PageDirector } from "./PageDirector";
import { PostCard } from "./PostCard";

export const PreviewStage = defineComponent(
  (props: {
    state: BymarkState;
    avatar: string | null;
    image: string | null;
    sceneImage: string | null;
    pages: PaginatedPage[];
    activePageIndex: number;
    onPageChange: (index: number) => void;
    onRemoveManualBreak: (index: number) => void;
    onSceneCardMove: (x: number, y: number) => void;
    onImageScaleLimitChange: (limit: number) => void;
    overflowing: boolean;
    onOverflowChange: (overflowing: boolean) => void;
    onExport: () => void;
    onArchive: () => void;
    exporting: boolean;
    exportFormat: ExportFormat;
    onCardRef: (node: HTMLDivElement | null) => void;
  }) => {
    const shellRef = ref<HTMLDivElement | null>(null);
    const viewportRef = ref<HTMLDivElement | null>(null);
    const headingRef = ref<HTMLDivElement | null>(null);
    const mobileActionsRef = ref<HTMLDivElement | null>(null);
    const cardRef = ref<HTMLDivElement | null>(null);
    const scale = ref(1);
    const previewWidth = computed(() => `${800 * scale.value}px`);
    const statusOffset = ref(0);
    const layoutReady = ref(false);
    const height = computed(() => RATIO_HEIGHTS[props.state.ratio]);
    const preset = computed(() =>
      ASPECT_PRESETS.find((item) => item.ratio === props.state.ratio),
    );
    const currentText = computed(() => props.pages[props.activePageIndex]?.text ?? "");
    let pageSwipe: {
      pointerId: number;
      startX: number;
      startY: number;
    } | null = null;
    let observer: ResizeObserver | undefined;
    let statusFrame: number | undefined;
    let alignmentSettleTimer: number | undefined;
    let layoutReadyFrame: number | undefined;
    const markLayoutReady = () => {
      if (layoutReady.value || layoutReadyFrame !== undefined) return;
      // Keep layout transitions disabled through the first correctly measured
      // paint. Enabling them one frame later preserves smooth ratio/scene
      // changes without animating from the temporary 1:1 startup scale.
      layoutReadyFrame = requestAnimationFrame(() => {
        layoutReadyFrame = undefined;
        layoutReady.value = true;
      });
    };
    const syncStatusPosition = () => {
      statusFrame = undefined;
      const heading = headingRef.value;
      const card = cardRef.value;
      if (!heading || !card) return;
      // The status is a flex item at the heading's right edge. Offset it by
      // the exact difference so its visual right edge equals the card's.
      const cardRect = card.getBoundingClientRect();
      const headingRect = heading.getBoundingClientRect();
      statusOffset.value = headingRect.right - cardRect.right;
      markLayoutReady();
    };
    const scheduleStatusPosition = () => {
      if (statusFrame !== undefined) cancelAnimationFrame(statusFrame);
      statusFrame = requestAnimationFrame(syncStatusPosition);
    };
    const scheduleSettledAlignment = () => {
      scheduleStatusPosition();
      if (alignmentSettleTimer !== undefined) window.clearTimeout(alignmentSettleTimer);
      alignmentSettleTimer = window.setTimeout(scheduleStatusPosition, 300);
    };
    const syncInitialAlignment = () => {
      nextTick(() => {
        syncStatusPosition();
        scheduleSettledAlignment();
      });
    };
    const setCardRef = (node: HTMLDivElement | null) => {
      cardRef.value = node;
      props.onCardRef(node);
      if (node && !layoutReady.value) syncInitialAlignment();
      else scheduleSettledAlignment();
    };
    const canSwipePages = () =>
      props.pages.length > 1 && props.state.canvasStyle !== "scene";
    const releasePageSwipePointer = (shell: HTMLDivElement, pointerId: number) => {
      try {
        if (shell.hasPointerCapture(pointerId)) shell.releasePointerCapture(pointerId);
      } catch {
        // Synthetic pointer events do not always have an active pointer to
        // release. The gesture itself still has enough data to complete.
      }
    };
    const beginPageSwipe = (event: PointerEvent) => {
      if (!canSwipePages() || !event.isPrimary || event.pointerType === "mouse") return;
      const shell = event.currentTarget as HTMLDivElement;
      pageSwipe = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
      try {
        shell.setPointerCapture(event.pointerId);
      } catch {
        // Some test and embedded-browser pointer events cannot be captured.
      }
    };
    const endPageSwipe = (event: PointerEvent) => {
      if (!pageSwipe || pageSwipe.pointerId !== event.pointerId) return;
      const shell = event.currentTarget as HTMLDivElement;
      releasePageSwipePointer(shell, event.pointerId);
      const deltaX = event.clientX - pageSwipe.startX;
      const deltaY = event.clientY - pageSwipe.startY;
      pageSwipe = null;
      // Ignore taps and vertical scrolls. A deliberate 48px horizontal swipe
      // moves exactly one page, matching the direction of the card gesture.
      if (Math.abs(deltaX) < 48 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.25) return;
      const nextIndex = props.activePageIndex + (deltaX < 0 ? 1 : -1);
      if (nextIndex >= 0 && nextIndex < props.pages.length) props.onPageChange(nextIndex);
    };
    const cancelPageSwipe = (event: PointerEvent) => {
      if (!pageSwipe || pageSwipe.pointerId !== event.pointerId) return;
      const shell = event.currentTarget as HTMLDivElement;
      releasePageSwipePointer(shell, event.pointerId);
      pageSwipe = null;
    };
    const update = () => {
      const shell = shellRef.value;
      const viewport = viewportRef.value;
      if (!shell || !viewport || !shell.clientWidth || !viewport.clientHeight)
        return;
      const mobileActionHeight = mobileActionsRef.value?.offsetHeight ?? 0;
      const availableHeight = viewport.clientHeight - (mobileActionHeight ? mobileActionHeight + 66 : 0);
      scale.value = Math.min(
        1,
        shell.clientWidth / 800,
        Math.max(1, availableHeight) / height.value,
      );
      if (!layoutReady.value) syncInitialAlignment();
      else scheduleSettledAlignment();
    };
    onMounted(() => {
      update();
      observer = new ResizeObserver(update);
      if (shellRef.value) observer.observe(shellRef.value);
      if (viewportRef.value) observer.observe(viewportRef.value);
      if (mobileActionsRef.value) observer.observe(mobileActionsRef.value);
      window.addEventListener("resize", update);
    });
    onBeforeUnmount(() => {
      observer?.disconnect();
      if (statusFrame !== undefined) cancelAnimationFrame(statusFrame);
      if (alignmentSettleTimer !== undefined) window.clearTimeout(alignmentSettleTimer);
      if (layoutReadyFrame !== undefined) cancelAnimationFrame(layoutReadyFrame);
      window.removeEventListener("resize", update);
    });
    watch(height, update);
    watch(
      [
        () => props.state.canvasStyle,
        () => props.state.visualStyle,
        () => props.state.sceneCardY,
        () => props.state.sceneCardScale,
        () => props.state.sceneCardHeight,
        () => props.state.sceneCardPadding,
        () => props.state.sceneCardRatio,
        () => props.state.showTime,
        () => props.state.showDate,
        () => props.state.showLocation,
        () => props.state.showSignature,
        () => props.activePageIndex,
      ],
      () => nextTick(scheduleSettledAlignment),
      { flush: "post" },
    );

    return () => (
      <section
        id="mobile-preview-panel"
        class={["preview-panel", !layoutReady.value && "preview-layout-initializing"]}
        aria-label="最终图片实时预览"
      >
        <div
          ref={headingRef}
          class="preview-heading"
          style={{ width: previewWidth.value }}
        >
          <div class="preview-heading-copy">
            <span class="eyebrow">实时预览</span>
            <p>
              {props.state.exportMode === "douyin-cover"
                ? "9:16 导出 · 中央 3:4 内容区 · "
                : preset.value
                  ? `${preset.value.ratio} · ${preset.value.name} · `
                  : ""}
              {props.pages.length > 1 ? `${props.pages.length} 页连续图文` : "单页图文"}
            </p>
          </div>
          <div
            class={["status-pill", props.overflowing && "status-warning"]}
            style={{ right: `${statusOffset.value}px` }}
          >
            <span />
            {props.overflowing ? "当前页过密" : "已同步"}
          </div>
        </div>
        <div ref={viewportRef} class="preview-viewport">
          <div class={["preview-page-stage", props.pages.length === 1 && "preview-page-stage-single"]}>
            {props.pages.length > 1 && <button
              type="button"
              class="preview-page-arrow"
              aria-label="上一页"
              disabled={props.activePageIndex === 0}
              onClick={() => props.onPageChange(props.activePageIndex - 1)}
            >
              <ChevronLeft size={18} />
            </button>}
            <div
              ref={shellRef}
              class={["preview-shell", canSwipePages() && "preview-shell-swipeable"]}
              style={{ height: `${height.value * scale.value}px` }}
              aria-label={canSwipePages() ? "向左或向右滑动可切换分页" : undefined}
              onPointerdown={beginPageSwipe}
              onPointerup={endPageSwipe}
              onPointercancel={cancelPageSwipe}
            >
              <div
                class="preview-scaler"
                style={{
                  width: "800px",
                  height: `${height.value}px`,
                  transform: `translateX(-50%) scale(${scale.value})`,
                }}
              >
                <Transition
                  name={props.state.canvasStyle === "scene" ? "canvas-switch-forward" : "canvas-switch-backward"}
                  mode="out-in"
                >
                  <PostCard
                    key={`${props.state.visualStyle}-${props.state.canvasStyle}-${props.activePageIndex}`}
                    state={props.state}
                    pageText={currentText.value}
                    avatar={props.avatar}
                    image={props.activePageIndex === 0 ? props.image : null}
                    sceneImage={props.sceneImage}
                    pageIndex={props.activePageIndex}
                    totalPages={props.pages.length}
                    onSceneCardMove={props.onSceneCardMove}
                    onImageScaleLimitChange={props.onImageScaleLimitChange}
                    onOverflowChange={props.onOverflowChange}
                    cardRef={setCardRef}
                  />
                </Transition>
              </div>
            </div>
            {props.pages.length > 1 && <button
              type="button"
              class="preview-page-arrow"
              aria-label="下一页"
              disabled={props.activePageIndex >= props.pages.length - 1}
              onClick={() => props.onPageChange(props.activePageIndex + 1)}
            >
              <ChevronRight size={18} />
            </button>}
          </div>
          <div ref={mobileActionsRef} class="mobile-preview-actions">
            <button
              type="button"
              class="mobile-preview-archive"
              onClick={props.onArchive}
              disabled={props.overflowing}
            >
              <Archive size={16} /> 归档
            </button>
            <button
              type="button"
              class="mobile-preview-export"
              onClick={props.onExport}
              disabled={props.overflowing || props.exporting}
            >
              <Download size={16} />
              {props.exporting
                ? "正在导出…"
                : props.overflowing
                  ? "当前页内容过密"
                  : props.pages.length > 1
                    ? `导出 ${props.pages.length} 页`
                    : "导出图片"}
            </button>
          </div>
          {props.pages.length > 1 && (
            <div class="page-director-mobile">
              <PageDirector
                pages={props.pages}
                width={previewWidth.value}
                activePageIndex={props.activePageIndex}
                onPageChange={props.onPageChange}
                onRemoveManualBreak={props.onRemoveManualBreak}
              />
            </div>
          )}
        </div>
        {props.pages.length > 1 && (
          <div class="page-director-desktop">
            <PageDirector
              pages={props.pages}
              width={previewWidth.value}
              activePageIndex={props.activePageIndex}
              onPageChange={props.onPageChange}
              onRemoveManualBreak={props.onRemoveManualBreak}
            />
          </div>
        )}
      </section>
    );
  },
  {
    props: [
      "state",
      "avatar",
      "image",
      "sceneImage",
      "pages",
      "activePageIndex",
      "onPageChange",
      "onRemoveManualBreak",
      "onSceneCardMove",
      "onImageScaleLimitChange",
      "overflowing",
      "onOverflowChange",
      "onExport",
      "onArchive",
      "exporting",
      "exportFormat",
      "onCardRef",
    ],
  },
);
