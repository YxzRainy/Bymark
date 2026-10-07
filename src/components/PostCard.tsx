import {
  BarChart3,
  BadgeCheck,
  Bookmark,
  Clock3,
  Heart,
  MessageCircle,
  Repeat2,
  Share,
} from "lucide-vue-next";
import {
  computed,
  defineComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import type { BymarkState } from "../bymark";
import {
  formatDate,
  formatTime,
  RATIO_HEIGHTS,
  signatureFor,
} from "../bymark";
import { imageScaleLimitForFrame, sceneImageLayoutFor } from "../imageScale";
import { MarkdownContent } from "../markdown";
import { sceneBackdropFor } from "../sceneBackdrops";

function hasSocialMetric(value: string) {
  return value.trim() !== "" && Number(value) !== 0;
}

function imageHeightBasisFor(state: BymarkState) {
  if (state.visualStyle === "folio" && state.canvasStyle === "scene" && state.sceneCardRatio === "4:3") {
    return 62;
  }
  return state.ratio === "3:4" ? 47.8 : 42;
}

const SCENE_CARD_WIDTH = 800 * 0.72;

function sceneCardBaseHeight(ratio: BymarkState["sceneCardRatio"]) {
  if (ratio === "4:3") return SCENE_CARD_WIDTH * 3 / 4;
  if (ratio === "1:1") return SCENE_CARD_WIDTH;
  return SCENE_CARD_WIDTH * 4 / 3;
}

function sceneCardPaddingBase(state: BymarkState, isFolio: boolean) {
  if (isFolio) return [62, 68, 50, 68] as const;
  if (state.exportMode === "douyin-cover") return [96, 100, 84, 100] as const;
  if (state.ratio === "2:3") return [66, 112, 54, 68] as const;
  if (state.ratio === "9:16") return [134, 68, 72, 68] as const;
  return [62, 68, 50, 68] as const;
}

function pageCopySource(source: string) {
  // A manual page marker is inserted with blank lines on both sides so it is
  // readable in the editor. Those wrapper lines do not belong to either page:
  // if rendered, the new page starts several copy lines lower than the card's
  // normal text origin.
  return source
    .replace(/^(?:[ \t]*\n)+/u, "")
    .replace(/(?:\n[ \t]*)+$/u, "");
}

export const PostCard = defineComponent(
  (props: {
    renderMode?: "preview" | "export" | "measure";
    state: BymarkState;
    pageText?: string;
    avatar: string | null;
    image: string | null;
    sceneImage: string | null;
    pageIndex: number;
    totalPages: number;
    onSceneCardMove: (x: number, y: number) => void;
    onImageScaleLimitChange: (limit: number) => void;
    onOverflowChange: (overflowing: boolean) => void;
    cardRef: (node: HTMLDivElement | null) => void;
  }) => {
    const copyRef = ref<HTMLDivElement | null>(null);
    const contentRef = ref<HTMLDivElement | null>(null);
    const imageRef = ref<HTMLImageElement | null>(null);
    const rootRef = ref<HTMLDivElement | null>(null);
    const signatureRef = ref<HTMLDivElement | null>(null);
    const imageAspectRatio = shallowRef<number | null>(null);
    const imageFrameMaxHeight = shallowRef<number | null>(null);
    const sceneImageLayout = shallowRef<ReturnType<typeof sceneImageLayoutFor> | null>(null);
    const signatureScale = ref(1);
    const signatureText = computed(() =>
      signatureFor(props.state.signature, props.state.userId),
    );
    const copySource = computed(() =>
      pageCopySource(props.pageText ?? props.state.text),
    );
    const sceneBackdrop = computed(() => sceneBackdropFor(props.state.sceneBackdrop));
    const meta = computed(() =>
      [
        props.state.showTime ? formatTime(props.state.time) : "",
        props.state.showDate ? formatDate(props.state.date) : "",
        props.state.showLocation ? props.state.location.trim() : "",
      ].filter(Boolean),
    );
    let observer: ResizeObserver | undefined;
    let signatureObserver: ResizeObserver | undefined;
    let sceneDrag: {
      pointerId: number;
      card: HTMLElement;
      startClientX: number;
      startClientY: number;
      startX: number;
      startY: number;
      viewportWidth: number;
      viewportHeight: number;
      canvasWidth: number;
      canvasHeight: number;
      scale: number;
      minX: number;
      maxX: number;
      minY: number;
      maxY: number;
      x: number;
      y: number;
    } | null = null;
    let sceneDragFrame: number | undefined;
    let imageMeasureFrame: number | undefined;
    let reportedImageScaleLimit: number | undefined;
    const usesBackdrop = () => props.state.canvasStyle === "scene";
    const usesAdaptiveSceneImage = () => props.state.visualStyle === "folio" && usesBackdrop() && Boolean(props.image);
    const paintSceneDrag = () => {
      sceneDragFrame = undefined;
      if (!sceneDrag) return;
      // The individual CSS scale is applied outside this transform. Undo it
      // here so the card follows the pointer 1:1 at every scene-card size.
      const offsetX = ((sceneDrag.x - sceneDrag.startX) / 100) * sceneDrag.canvasWidth / sceneDrag.scale;
      const offsetY = ((sceneDrag.y - sceneDrag.startY) / 100) * sceneDrag.canvasHeight / sceneDrag.scale;
      sceneDrag.card.style.transform = `translate3d(${offsetX}px, ${offsetY}px, 0)`;
    };
    const beginSceneDrag = (event: PointerEvent) => {
      if (!usesBackdrop() || event.button !== 0 || !event.isPrimary || sceneDrag || !rootRef.value) return;
      const card = event.currentTarget as HTMLElement;
      const rootBounds = rootRef.value.getBoundingClientRect();
      const cardBounds = card.getBoundingClientRect();
      sceneDrag = {
        pointerId: event.pointerId,
        card,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: props.state.sceneCardX,
        startY: props.state.sceneCardY,
        viewportWidth: rootBounds.width,
        viewportHeight: rootBounds.height,
        canvasWidth: rootRef.value.offsetWidth,
        canvasHeight: rootRef.value.offsetHeight,
        scale: props.state.sceneCardScale / 100,
        minX: Math.max(5, props.state.sceneCardX + ((rootBounds.left - cardBounds.left) / rootBounds.width) * 100),
        maxX: Math.min(95, props.state.sceneCardX + ((rootBounds.right - cardBounds.right) / rootBounds.width) * 100),
        minY: Math.max(5, props.state.sceneCardY + ((rootBounds.top - cardBounds.top) / rootBounds.height) * 100),
        maxY: Math.min(95, props.state.sceneCardY + ((rootBounds.bottom - cardBounds.bottom) / rootBounds.height) * 100),
        x: props.state.sceneCardX,
        y: props.state.sceneCardY,
      };
      card.classList.add("post-card-inner-dragging");
      card.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    const updateSceneDragPosition = (event: PointerEvent) => {
      if (!sceneDrag || sceneDrag.pointerId !== event.pointerId) return;
      const x = sceneDrag.startX + ((event.clientX - sceneDrag.startClientX) / sceneDrag.viewportWidth) * 100;
      const y = sceneDrag.startY + ((event.clientY - sceneDrag.startClientY) / sceneDrag.viewportHeight) * 100;
      sceneDrag.x = Math.min(sceneDrag.maxX, Math.max(sceneDrag.minX, x));
      sceneDrag.y = Math.min(sceneDrag.maxY, Math.max(sceneDrag.minY, y));
    };
    const moveSceneDrag = (event: PointerEvent) => {
      if (!sceneDrag || sceneDrag.pointerId !== event.pointerId) return;
      updateSceneDragPosition(event);
      if (sceneDragFrame === undefined) sceneDragFrame = requestAnimationFrame(paintSceneDrag);
    };
    const endSceneDrag = (event: PointerEvent) => {
      if (!sceneDrag || sceneDrag.pointerId !== event.pointerId) return;
      // Pointerup may arrive before the last queued animation frame. Capture
      // its final position; cancellation/capture loss keeps the last move.
      if (event.type === "pointerup") updateSceneDragPosition(event);
      const drag = sceneDrag;
      sceneDrag = null;
      const { card } = drag;
      if (sceneDragFrame !== undefined) cancelAnimationFrame(sceneDragFrame);
      sceneDragFrame = undefined;
      const x = Math.round(drag.x * 100) / 100;
      const y = Math.round(drag.y * 100) / 100;
      rootRef.value?.style.setProperty("--scene-card-x", `${x}%`);
      rootRef.value?.style.setProperty("--scene-card-y", `${y}%`);
      card.style.removeProperty("transform");
      card.classList.remove("post-card-inner-dragging");
      if (card.hasPointerCapture(event.pointerId)) card.releasePointerCapture(event.pointerId);
      if (x !== drag.startX || y !== drag.startY) props.onSceneCardMove(x, y);
    };
    const measure = () => {
      const node = copyRef.value;
      if (!node) return;
      const overflowing =
        node.scrollHeight > node.clientHeight + 1 ||
        node.scrollWidth > node.clientWidth + 1;
      props.onOverflowChange(overflowing);
    };
    const measureImageScaleLimit = () => {
      const content = contentRef.value;
      const aspectRatio = imageAspectRatio.value;
      if (!props.image || !content || !aspectRatio) return;
      if (usesAdaptiveSceneImage() && rootRef.value) {
        const inner = content.parentElement!;
        const cardBaseHeight = sceneCardBaseHeight(props.state.sceneCardRatio);
        const minimumCardHeight = cardBaseHeight * props.state.sceneCardHeight / 100;
        const scale = props.state.sceneCardScale / 100;
        const canvasHeight = rootRef.value.clientHeight;
        // Keep the configured card's centre while growing, and reserve enough
        // canvas space above and below it for the complete enlarged card.
        const centreY = canvasHeight * props.state.sceneCardY / 100
          + (minimumCardHeight - cardBaseHeight) * scale / 2;
        const maximumCardHeight = Math.max(minimumCardHeight,
          2 * Math.min(centreY, canvasHeight - centreY) / scale,
        );
        const chromeHeight = inner.offsetHeight - content.clientHeight;
        const copyHeight = Math.min(copyRef.value?.scrollHeight ?? 0,
          Math.max(0, minimumCardHeight - chromeHeight - 15),
        );
        const layout = sceneImageLayoutFor({
          contentWidth: content.clientWidth,
          imageAspectRatio: aspectRatio,
          imageScale: props.state.imageScale,
          minimumCardHeight,
          maximumCardHeight,
          reservedHeight: chromeHeight + copyHeight + 15,
        });
        const previous = sceneImageLayout.value;
        if (!previous || Math.abs(previous.height - layout.height) > 0.5
          || Math.abs(previous.width - layout.width) > 0.5
          || Math.abs(previous.cardHeight - layout.cardHeight) > 0.5) {
          sceneImageLayout.value = layout;
        }
        if (layout.scaleLimit !== reportedImageScaleLimit) {
          reportedImageScaleLimit = layout.scaleLimit;
          props.onImageScaleLimitChange(layout.scaleLimit);
        }
        return;
      }
      const heightBasis = imageHeightBasisFor(props.state);
      const nextFrameMaxHeight = content.clientWidth / aspectRatio;
      if (
        imageFrameMaxHeight.value === null ||
        Math.abs(nextFrameMaxHeight - imageFrameMaxHeight.value) > 0.5
      ) {
        imageFrameMaxHeight.value = nextFrameMaxHeight;
      }
      const limit = imageScaleLimitForFrame({
        contentWidth: content.clientWidth,
        contentHeight: content.clientHeight,
        imageAspectRatio: aspectRatio,
        heightBasis,
        reservedHeight: props.state.visualStyle === "folio" && props.state.canvasStyle === "scene" && props.state.sceneCardRatio === "4:3"
          ? (copyRef.value?.scrollHeight ?? 0) + 15
          : 0,
      });
      if (limit === reportedImageScaleLimit) return;
      reportedImageScaleLimit = limit;
      props.onImageScaleLimitChange(limit);
    };
    const syncImageAspectRatio = (image: HTMLImageElement | null) => {
      if (!image?.naturalWidth || !image.naturalHeight) return;
      imageAspectRatio.value = image.naturalWidth / image.naturalHeight;
      nextTick(measureImageScaleLimit);
    };
    const measureSignature = () => {
      const signature = signatureRef.value;
      if (!signature) return;

      // The card always renders on an 800px design canvas, but the timestamp
      // can leave the signature less room. Measure the text and reduce its
      // font size only when necessary, so it remains complete on one line.
      const currentScale = signatureScale.value || 1;
      const unscaledWidth = signature.scrollWidth / currentScale;
      const availableWidth = signature.clientWidth;
      const nextScale = unscaledWidth > 0
        ? Math.min(1, Math.max(0.05, availableWidth / unscaledWidth))
        : 1;

      if (Math.abs(nextScale - signatureScale.value) > 0.002) {
        signatureScale.value = nextScale;
      }
    };
    onMounted(() => {
      props.cardRef(rootRef.value);
      observer = new ResizeObserver(() => {
        measure();
        // Enlarging the photo also resizes this observed content region.
        // Measure on the next frame instead of resizing it again inside the
        // observer delivery cycle (which triggers a loop warning in WebKit).
        if (imageMeasureFrame === undefined) {
          imageMeasureFrame = requestAnimationFrame(() => {
            imageMeasureFrame = undefined;
            measureImageScaleLimit();
          });
        }
      });
      if (copyRef.value) observer.observe(copyRef.value);
      if (contentRef.value) observer.observe(contentRef.value);
      signatureObserver = new ResizeObserver(measureSignature);
      if (signatureRef.value) signatureObserver.observe(signatureRef.value);
      if (signatureRef.value?.parentElement) signatureObserver.observe(signatureRef.value.parentElement);
      measure();
      measureSignature();
      syncImageAspectRatio(imageRef.value);
    });
    onBeforeUnmount(() => {
      observer?.disconnect();
      signatureObserver?.disconnect();
      if (sceneDragFrame !== undefined) cancelAnimationFrame(sceneDragFrame);
      if (imageMeasureFrame !== undefined) cancelAnimationFrame(imageMeasureFrame);
      props.cardRef(null);
    });
    watch(
      () => [
        props.image,
        props.state.fontScale,
        props.state.lineHeightScale,
        props.state.sceneCardHeight,
        props.state.sceneCardScale,
        props.state.sceneCardY,
        props.state.sceneCardPadding,
        props.state.sceneCardRatio,
        props.state.canvasStyle,
        props.state.ratio,
        props.state.visualStyle,
        props.pageText,
        props.state.showSignature,
        signatureText.value,
        props.state.showTime,
        props.state.showDate,
        props.state.showLocation,
        props.state.imagePosition,
        props.state.imageScale,
      ],
      () => nextTick(() => {
        measure();
        measureSignature();
        measureImageScaleLimit();
      }),
      { flush: "post" },
    );
    watch(() => props.image, () => {
      // A replacement must be measured with its own natural dimensions;
      // the previous photo's limit must not clamp the new saved scale.
      imageAspectRatio.value = null;
      imageFrameMaxHeight.value = null;
      sceneImageLayout.value = null;
      reportedImageScaleLimit = undefined;
      nextTick(() => syncImageAspectRatio(imageRef.value));
    });

    return () => {
      const displayName =
        props.state.name.trim().replace(/^@+/, "") || "未命名";
      const initial = Array.from(displayName)[0] || "留";
      const hasSignature =
        props.state.showSignature && Boolean(signatureText.value);
      const hasBackdrop = usesBackdrop();
      const isFolio = props.state.visualStyle === "folio";
      const sceneCardBaseHeightValue = sceneCardBaseHeight(props.state.sceneCardRatio);
      const sceneCardHeightScale = props.state.sceneCardHeight / 100;
      const sceneCardScale = props.state.sceneCardScale / 100;
      const paddingScale = props.state.sceneCardPadding / 100;
      const [scenePaddingTop, scenePaddingRight, scenePaddingBottom, scenePaddingLeft] = sceneCardPaddingBase(props.state, isFolio);
      const imageHeightBasis = imageHeightBasisFor(props.state);
      const imageHeight = imageHeightBasis * (props.state.imageScale / 100);
      const adaptiveImage = usesAdaptiveSceneImage() ? sceneImageLayout.value : null;
      const minimumSceneCardHeight = sceneCardBaseHeightValue * sceneCardHeightScale;
      const sceneCardHeight = adaptiveImage?.cardHeight ?? minimumSceneCardHeight;
      const contentImage = props.image && (
        <div
          class={[
            "post-image-wrap",
            `post-image-${props.state.imagePosition}`,
            `post-image-align-${props.state.imageAlignment}`,
          ]}
          style={adaptiveImage ? {
            width: `${adaptiveImage.width}px`,
            height: `${adaptiveImage.height}px`,
            flex: `0 0 ${adaptiveImage.height}px`,
            maxHeight: `${adaptiveImage.height}px`,
          } : {
            flex: `0 1 ${imageHeight}%`,
            maxHeight: imageFrameMaxHeight.value === null
              ? `${imageHeight}%`
              : `min(${imageHeight}%, ${imageFrameMaxHeight.value}px)`,
            aspectRatio: imageAspectRatio.value ?? 16 / 9,
          }}
        >
          <img
            ref={imageRef}
            src={props.image}
            alt="用户上传的内容配图"
            onLoad={(event) => {
              const image = event.currentTarget as HTMLImageElement;
              syncImageAspectRatio(image);
              window.dispatchEvent(new Event("resize"));
            }}
          />
        </div>
      );
      return (
        <article
          ref={rootRef}
          class={[
            "post-card",
            `post-card-${props.state.theme}`,
            `post-card-${props.state.ratio.replace(":", "-")}`,
            props.state.exportMode === "douyin-cover" && "post-card-douyin-cover",
            hasBackdrop && "post-card-scene",
            hasBackdrop && props.state.sceneCardRatio === "4:3" && "post-card-scene-landscape",
            isFolio && "post-card-folio",
            props.image && "post-card-has-image",
            props.renderMode === "export" && "post-card-export-source",
          ]}
          style={{
            width: "800px",
            height: `${RATIO_HEIGHTS[props.state.ratio]}px`,
            background: hasBackdrop ? sceneBackdrop.value.gradient : undefined,
            "--copy-scale": props.state.fontScale / 100,
            "--copy-line-height-scale": props.state.lineHeightScale / 100,
            "--scene-overlay": props.state.sceneOverlay / 100,
            "--scene-card-scale": sceneCardScale,
            "--scene-card-height-scale": sceneCardHeightScale,
            "--scene-card-height": `${sceneCardHeight}px`,
            "--scene-card-anchor-offset": `${(sceneCardBaseHeightValue + sceneCardHeight - minimumSceneCardHeight) * sceneCardScale / 2}px`,
            "--scene-card-padding-top": `${scenePaddingTop * paddingScale}px`,
            "--scene-card-padding-right": `${scenePaddingRight * paddingScale}px`,
            "--scene-card-padding-bottom": `${scenePaddingBottom * paddingScale}px`,
            "--scene-card-padding-left": `${scenePaddingLeft * paddingScale}px`,
            "--scene-card-ratio": props.state.sceneCardRatio.replace(":", " / "),
            "--scene-card-x": `${props.state.sceneCardX}%`,
            "--scene-card-y": `${props.state.sceneCardY}%`,
          }}
          data-testid={props.renderMode === "export" ? undefined : "export-card"}
          data-export-render-card={props.renderMode === "export" ? "" : undefined}
          data-pagination-probe={props.renderMode === "measure" ? "" : undefined}
        >
          {hasBackdrop && props.sceneImage && (
            <img
              class="post-scene-image"
              src={props.sceneImage}
              alt=""
            />
          )}
          {hasBackdrop && <div class="post-scene-shade" aria-hidden="true" />}
          <div class={[
            "post-card-safe-frame",
            props.state.exportMode === "douyin-cover" && "post-card-safe-frame-douyin",
          ]}>
            <div
              class="post-card-inner"
              onPointerdown={hasBackdrop && props.renderMode !== "export" ? beginSceneDrag : undefined}
              onPointermove={hasBackdrop && props.renderMode !== "export" ? moveSceneDrag : undefined}
              onPointerup={hasBackdrop && props.renderMode !== "export" ? endSceneDrag : undefined}
              onPointercancel={hasBackdrop && props.renderMode !== "export" ? endSceneDrag : undefined}
              onLostpointercapture={hasBackdrop && props.renderMode !== "export" ? endSceneDrag : undefined}
              onDragstart={hasBackdrop ? (event: DragEvent) => event.preventDefault() : undefined}
            >
            {isFolio ? (
              <header class="post-author post-social-author">
                <div class="post-avatar">
                  {props.avatar ? (
                    <img src={props.avatar} alt="" />
                  ) : (
                    <span>{initial}</span>
                  )}
                </div>
                <div class="post-social-identity">
                  <div class="post-social-name-row">
                    <div class="post-name">{displayName}</div>
                    <BadgeCheck class="post-social-verified" aria-label="已认证" />
                  </div>
                  <div class="post-id">{props.state.userId || "@bymark"}</div>
                </div>
                <svg class="post-social-subscription-mark" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.4l-5.8-7.58-6.64 7.58H.48l8.6-9.83L0 1.15h7.59l5.24 6.92zm-1.29 19.46h2.04L6.48 3.43H4.29z" />
                </svg>
              </header>
            ) : (
              <header class="post-author">
              <div class="post-avatar">
                {props.avatar ? (
                  <img src={props.avatar} alt="" />
                ) : (
                  <span>{initial}</span>
                )}
              </div>
              <div class="min-w-0">
                <div class="post-name">{displayName}</div>
                <div class="post-id">{props.state.userId || "@bymark"}</div>
              </div>
              {props.totalPages > 1 && (
                <div class="post-page-number" aria-label={`第 ${props.pageIndex + 1} 页，共 ${props.totalPages} 页`}>
                  {String(props.pageIndex + 1).padStart(2, "0")} / {String(props.totalPages).padStart(2, "0")}
                </div>
              )}
              </header>
            )}
            <div ref={contentRef} class="post-content">
              {props.state.imagePosition === "above" && contentImage}
              <div ref={copyRef} class="post-copy">
                <MarkdownContent
                  source={copySource.value || "在这里留下你的文字。"}
                />
              </div>
              {props.state.imagePosition === "below" && contentImage}
            </div>
            {isFolio && (
              <div class="post-social-actions" aria-hidden="true">
                <span><MessageCircle />{hasSocialMetric(props.state.socialReplies) && <b><span>{props.state.socialReplies}</span></b>}</span>
                <span><Repeat2 />{hasSocialMetric(props.state.socialReposts) && <b><span>{props.state.socialReposts}</span></b>}</span>
                <span><Heart />{hasSocialMetric(props.state.socialLikes) && <b><span>{props.state.socialLikes}</span></b>}</span>
                <span><BarChart3 />{hasSocialMetric(props.state.socialViews) && <b><span>{props.state.socialViews}</span></b>}</span>
                <span><Bookmark /></span>
                <span><Share /></span>
              </div>
            )}
            {!isFolio && (meta.value.length > 0 || hasSignature) && (
              <footer class="post-footer">
                <div class="post-meta-row">
                  {meta.value.length > 0 && (
                    <div class="post-meta">
                      <Clock3 aria-hidden="true" />
                      <span>{meta.value.join(" · ")}</span>
                    </div>
                  )}
                  {hasSignature && (
                    <div
                      ref={signatureRef}
                      class="post-signature"
                      style={{ "--signature-scale": String(signatureScale.value) }}
                    >
                      {signatureText.value}
                    </div>
                  )}
                </div>
              </footer>
            )}
            </div>
          </div>
        </article>
      );
    };
  },
  {
    props: ["renderMode", "state", "pageText", "avatar", "image", "sceneImage", "pageIndex", "totalPages", "onSceneCardMove", "onImageScaleLimitChange", "onOverflowChange", "cardRef"],
  },
);
