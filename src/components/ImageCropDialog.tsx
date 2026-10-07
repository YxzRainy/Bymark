import { X } from 'lucide-vue-next';
import { computed, defineComponent, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, Transition } from 'vue';

type Rect = { x: number; y: number; width: number; height: number };
type DragMode = 'draw' | 'move' | 'nw' | 'ne' | 'sw' | 'se';
const corners = ['nw', 'ne', 'sw', 'se'] as const;
const fields = [['x', '左侧'], ['y', '顶部'], ['width', '宽度'], ['height', '高度']] as const;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

export const ImageCropDialog = defineComponent((props: {
  source: string;
  onClose: () => void;
  onApply: (file: File) => void | Promise<void>;
}) => {
  const dialog = ref<HTMLDialogElement | null>(null);
  const title = ref<HTMLHeadingElement | null>(null);
  const stage = ref<HTMLDivElement | null>(null);
  const surface = ref<HTMLDivElement | null>(null);
  const image = ref<HTMLImageElement | null>(null);
  const rect = ref<Rect>({ x: 0, y: 0, width: 1, height: 1 });
  const imageSize = shallowRef({ width: 0, height: 0 });
  const stageSize = shallowRef({ width: 640, height: 440 });
  const visible = shallowRef(false);
  const closing = shallowRef(false);
  const ready = shallowRef(false);
  const busy = shallowRef(false);
  const error = shallowRef('');
  let observer: ResizeObserver | undefined;
  let disposed = false;
  let opener: HTMLElement | null = null;
  let drag: { pointerId: number; mode: DragMode; x: number; y: number; rect: Rect } | null = null;

  const surfaceStyle = computed(() => {
    const { width, height } = imageSize.value;
    if (!width || !height) return undefined;
    const scale = Math.min(1, stageSize.value.width / width, stageSize.value.height / height);
    return { width: `${width * scale}px`, height: `${height * scale}px` };
  });
  const selectionStyle = computed(() => {
    const { width, height } = imageSize.value;
    const r = rect.value;
    return { left: `${r.x / width * 100}%`, top: `${r.y / height * 100}%`, width: `${r.width / width * 100}%`, height: `${r.height / height * 100}%` };
  });

  // Keep the native modal open through the leave transition, preserving its
  // focus trap and backdrop until the animation has finished.
  const finishClose = () => {
    dialog.value?.close();
    props.onClose();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  const close = () => {
    if (busy.value || closing.value) return;
    drag = null;
    closing.value = true;
    visible.value = false;
  };
  onMounted(async () => {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.documentElement.classList.add('image-crop-dialog-open');
    dialog.value?.showModal();
    visible.value = true;
    await nextTick();
    if (disposed) return;
    title.value?.focus({ preventScroll: true });
    observer = new ResizeObserver(([entry]) => {
      stageSize.value = { width: entry.contentRect.width, height: entry.contentRect.height };
    });
    if (stage.value) observer.observe(stage.value);
  });
  onBeforeUnmount(() => {
    disposed = true;
    observer?.disconnect();
    dialog.value?.close();
    document.documentElement.classList.remove('image-crop-dialog-open');
  });

  const reset = () => {
    const img = image.value;
    if (!img?.naturalWidth || !img.naturalHeight) return;
    imageSize.value = { width: img.naturalWidth, height: img.naturalHeight };
    rect.value = { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
    ready.value = true;
    error.value = '';
  };
  const normalize = (r: Rect): Rect => {
    const { width, height } = imageSize.value;
    const x = clamp(Math.round(r.x), 0, width - 1);
    const y = clamp(Math.round(r.y), 0, height - 1);
    return { x, y, width: clamp(Math.round(r.width), 1, width - x), height: clamp(Math.round(r.height), 1, height - y) };
  };
  const point = (event: PointerEvent) => {
    const bounds = surface.value?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return null;
    return {
      x: (event.clientX - bounds.left) / bounds.width * imageSize.value.width,
      y: (event.clientY - bounds.top) / bounds.height * imageSize.value.height,
    };
  };
  const start = (event: PointerEvent, mode: DragMode) => {
    if (!ready.value || busy.value || closing.value || drag || !event.isPrimary || event.button !== 0) return;
    const p = point(event);
    if (!p) return;
    event.preventDefault();
    event.stopPropagation();
    surface.value?.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, mode, ...p, rect: { ...rect.value } };
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const p = point(event);
    if (!p) return;
    const r = drag.rect;
    const { width, height } = imageSize.value;
    if (drag.mode === 'move') {
      rect.value = normalize({ ...r, x: clamp(r.x + p.x - drag.x, 0, width - r.width), y: clamp(r.y + p.y - drag.y, 0, height - r.height) });
    } else {
      const x = clamp(p.x, 0, width);
      const y = clamp(p.y, 0, height);
      const anchorX = drag.mode === 'draw' ? drag.x : drag.mode.includes('w') ? r.x + r.width : r.x;
      const anchorY = drag.mode === 'draw' ? drag.y : drag.mode.includes('n') ? r.y + r.height : r.y;
      rect.value = normalize({ x: Math.min(anchorX, x), y: Math.min(anchorY, y), width: Math.abs(x - anchorX), height: Math.abs(y - anchorY) });
    }
  };
  const stop = (event: PointerEvent) => {
    if (event.pointerId === drag?.pointerId) drag = null;
  };
  const update = (key: keyof Rect, event: Event) => {
    const value = (event.target as HTMLInputElement).valueAsNumber;
    if (!Number.isFinite(value) || !ready.value || busy.value || closing.value) return;
    rect.value = normalize({ ...rect.value, [key]: value });
  };
  const apply = async () => {
    if (!ready.value || busy.value || closing.value) return;
    drag = null;
    busy.value = true;
    error.value = '';
    try {
      const r = normalize(rect.value);
      const canvas = document.createElement('canvas');
      canvas.width = r.width;
      canvas.height = r.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error();
      context.drawImage(image.value!, r.x, r.y, r.width, r.height, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error()), 'image/png'));
      await props.onApply(new File([blob], 'cropped-image.png', { type: 'image/png' }));
      if (disposed) return;
      busy.value = false;
      close();
    } catch {
      if (!disposed) error.value = '裁剪或保存失败，请重试。';
    } finally { busy.value = false; }
  };
  const clickBackdrop = (event: MouseEvent) => {
    const element = dialog.value;
    if (!element || event.target !== element) return;
    const bounds = element.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  };

  return () => <dialog ref={dialog} class={['image-crop-dialog', closing.value && 'is-closing']} aria-labelledby="image-crop-title" aria-describedby="image-crop-help" onClick={clickBackdrop} onCancel={(event) => { event.preventDefault(); close(); }}>
    <Transition name="image-crop-panel" onAfterLeave={finishClose}>
      {visible.value && <section class="image-crop-panel" aria-busy={busy.value}>
        <header class="image-crop-header">
          <div><h2 ref={title} id="image-crop-title" tabindex={-1}>自由裁剪</h2><p id="image-crop-help">拖动框选区域，拖动选区移动，拖动四角调整大小。</p></div>
          <button type="button" class="image-crop-close" aria-label="关闭裁剪" disabled={busy.value || closing.value} onClick={close}><X size={18} /></button>
        </header>
        <div class="image-crop-body">
          <div ref={stage} class="image-crop-stage">
            <div ref={surface} class="image-crop-surface" style={surfaceStyle.value} onPointerdown={(event) => start(event, 'draw')} onPointermove={move} onPointerup={stop} onPointercancel={stop} onLostpointercapture={stop}>
              <img ref={image} src={props.source} alt="待裁剪配图" draggable={false} onLoad={reset} onError={() => { ready.value = false; error.value = '图片加载失败，请关闭后重试。'; }} />
              {ready.value && <div class="image-crop-mask" aria-hidden="true"><div style={selectionStyle.value} /></div>}
              {ready.value && <div class="image-crop-selection" style={selectionStyle.value} onPointerdown={(event) => start(event, 'move')}>
                {corners.map((corner) => <span key={corner} class={`image-crop-handle image-crop-${corner}`} aria-hidden="true" onPointerdown={(event) => start(event, corner)} />)}
              </div>}
            </div>
            {!ready.value && !error.value && <span class="image-crop-loading" role="status">正在加载图片…</span>}
          </div>
          <div class="image-crop-fields">{fields.map(([key, label]) => <label key={key}>{label}<input type="number" inputmode="numeric" step={1} min={key === 'x' || key === 'y' ? 0 : 1} max={key === 'x' ? imageSize.value.width - 1 : key === 'y' ? imageSize.value.height - 1 : key === 'width' ? imageSize.value.width - rect.value.x : imageSize.value.height - rect.value.y} value={rect.value[key]} disabled={!ready.value || busy.value || closing.value} onInput={(event) => update(key, event)} onBlur={(event) => { (event.target as HTMLInputElement).value = String(rect.value[key]); }} /></label>)}</div>
          {error.value && <p class="image-crop-error" role="alert">{error.value}</p>}
        </div>
        <footer class="image-crop-actions">
          <button type="button" disabled={!ready.value || busy.value || closing.value} onClick={reset}>重置选区</button>
          <button type="button" disabled={busy.value || closing.value} onClick={close}>取消</button>
          <button type="button" class="image-crop-confirm" disabled={!ready.value || busy.value || closing.value} onClick={apply}>{busy.value ? '保存中…' : '确认裁剪'}</button>
        </footer>
      </section>}
    </Transition>
  </dialog>;
}, { props: ['source', 'onClose', 'onApply'] });
