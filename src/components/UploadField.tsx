import { Crop, ImagePlus, Trash2, Upload } from "lucide-vue-next";
import { defineComponent, ref, shallowRef, Teleport } from "vue";
import { ImageCropDialog } from './ImageCropDialog';

export const UploadField = defineComponent((props: {
  value: string | null;
  kind: "avatar" | "image" | "scene";
  onFile: (file: File) => void | Promise<void>;
  onRemove: () => void;
}) => {
  const inputRef = ref<HTMLInputElement | null>(null);
  const cropSource = ref<string | null>(null);
  const id = `bymark-upload-${props.kind}`;
  const isAvatar = props.kind === "avatar";
  const isScene = props.kind === "scene";
  const label = isAvatar ? "头像" : isScene ? "场景背景" : "配图";
  const supportedImageTypes = ["image/jpeg", "image/png", "image/webp"];
  const isDragging = ref(false);
  const uploading = shallowRef(false);
  const chooseFile = () => inputRef.value?.click();
  const useFile = async (file: File | undefined) => {
    if (!file || uploading.value || !supportedImageTypes.includes(file.type)) return;
    uploading.value = true;
    try {
      await props.onFile(file);
    } catch {
      // The parent reports decoding or persistence errors through its notice.
    } finally {
      uploading.value = false;
    }
  };
  const receiveFile = (event: Event) => {
    const input = event.target as HTMLInputElement;
    useFile(input.files?.[0]);
    input.value = "";
  };
  const startDrag = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    isDragging.value = true;
  };
  const endDrag = (event: DragEvent) => {
    event.preventDefault();
    isDragging.value = false;
  };
  const receiveDrop = (event: DragEvent) => {
    event.preventDefault();
    isDragging.value = false;
    useFile(Array.from(event.dataTransfer?.files ?? []).find((file) => supportedImageTypes.includes(file.type)));
  };

  return () => (
    <div class="upload-row" aria-busy={uploading.value}>
      <input
        id={id}
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        class="sr-only"
        disabled={uploading.value}
        aria-label={isAvatar ? "选择头像图片" : isScene ? "选择场景背景图片" : "选择内容配图"}
        onChange={receiveFile}
      />
      <button
        type="button"
        class={["upload-preview", isAvatar && "avatar-preview", isDragging.value && "upload-preview-drop-active"]}
        onClick={chooseFile}
        disabled={uploading.value}
        onDragenter={startDrag}
        onDragover={startDrag}
        onDragleave={endDrag}
        onDrop={receiveDrop}
        aria-label={props.value ? `替换当前${label}` : `上传${label}`}
        title={`拖入${label}或点击上传`}
      >
        {props.value ? (
          <img src={props.value} alt={`当前${label}`} />
        ) : (
          <span class="upload-empty">
            {isAvatar ? <Upload size={16} /> : <ImagePlus size={18} />}
          </span>
        )}
      </button>
      {props.value && (
        <div class="upload-actions">
          {props.kind === 'image' && <button type="button" class="icon-button" disabled={uploading.value} aria-label="自由裁剪配图" title="自由裁剪" onClick={(event) => { (event.currentTarget as HTMLButtonElement).focus({ preventScroll: true }); cropSource.value = props.value; }}><Crop size={15} /></button>}
          <button
            type="button"
            class="icon-button"
            disabled={uploading.value}
            onClick={props.onRemove}
            aria-label={isAvatar ? "恢复默认头像" : `删除${label}`}
          >
            <Trash2 size={15} />
          </button>
        </div>
      )}
      {cropSource.value && <Teleport to="body"><ImageCropDialog source={cropSource.value} onClose={() => { cropSource.value = null; }} onApply={props.onFile} /></Teleport>}
    </div>
  );
}, {
  props: ["value", "kind", "onFile", "onRemove"],
});
