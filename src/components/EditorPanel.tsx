import {
  Bold,
  Archive,
  ClipboardPaste,
  Clock3,
  Copy,
  ChevronDown,
  ChevronUp,
  FileText,
  Heading1,
  Italic,
  List,
  ListOrdered,
  Minus,
  Plus,
  Quote,
  Redo2,
  Rows3,
  Scissors,
  Send,
  SlidersHorizontal,
  Undo2,
} from "lucide-vue-next";
import {
  computed,
  defineComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  Teleport,
  watch,
} from "vue";
import type { BrandTemplate } from "../brandTemplates";
import type { ExportEstimate, ExportFormat, ExportResolution } from "../exportOptions";
import { markdownToPlainText } from "../markdown";
import { PAGE_BREAK_MARKER } from "../pagination";
import type { BymarkState } from "../bymark";
import { UpdateIndicator } from "./UpdateIndicator";
import { ASPECT_PRESETS, WORK_TITLE_MAX_LENGTH } from "../bymark";
import { IMAGE_SCALE_MAX, IMAGE_SCALE_MIN } from "../imageScale";
import { countCharacters, countChineseCharacters } from "../textMetrics";
import { BrandTemplateLibrary } from "./BrandTemplateLibrary";
import { BackdropControls } from "./BackdropControls";
import { LayoutReveal } from "./LayoutReveal";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { SocialMetricsControls } from "./SocialMetricsControls";
import { TimePicker } from "./TimePicker";
import { DatePicker } from "./DatePicker";
import { Toggle } from "./Toggle";
import { ThemeToggle } from "./ThemeToggle";
import { ExportButton, type ExportButtonStatus } from "./ExportButton";
import { UploadField } from "./UploadField";

const TEXTAREA_MIN_HEIGHT = 224;
const TEXTAREA_HEIGHT_ANCHOR_MS = 260;
type EditorTab = "content" | "layout" | "publish";

function SwitchRow(props: {
  label: string;
  ariaLabel?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div class="switch-row">
      <span>{props.label}</span>
      <Toggle
        checked={props.checked}
        onChange={props.onChange}
        label={props.ariaLabel ?? props.label}
      />
    </div>
  );
}

type LineFormat =
  | "heading-1"
  | "heading-3"
  | "quote"
  | "unordered-list"
  | "ordered-list";

export const EditorPanel = defineComponent(
  (props: {
    state: BymarkState;
    update: <K extends keyof BymarkState>(
      key: K,
      value: BymarkState[K],
    ) => void;
    avatar: string | null;
    image: string | null;
    imageScaleMax: number;
    sceneImage: string | null;
    onAvatarFile: (file: File) => void | Promise<void>;
    onImageFile: (file: File) => void | Promise<void>;
    onSceneImageFile: (file: File) => void | Promise<void>;
    onRemoveAvatar: () => void;
    onRemoveImage: () => void;
    onRemoveSceneImage: () => void;
    onCurrentTime: () => void;
    brandTemplates: BrandTemplate[];
    templatesLoading: boolean;
    templatesPending: boolean;
    onSaveBrand: (title: string) => void;
    onUseBrand: (id: string) => void;
    onDeleteBrand: (id: string) => void;
    exportFormat: ExportFormat;
    exportResolution: ExportResolution;
    exportEstimate: ExportEstimate;
    onExportFormat: (format: ExportFormat) => void;
    onExportResolution: (resolution: ExportResolution) => void;
    onExport: (useCurrentTime: boolean) => void;
    onArchive: () => void;
    onOpenArchive: () => void;
    onCopyImage: () => void;
    exporting: boolean;
    exportProgress: number;
    exportStatus: ExportButtonStatus;
    overflowing: boolean;
    historyResetToken: number;
    pageCount: number;
  }) => {
    const titleInputRef = ref<HTMLInputElement | null>(null);
    const textAreaRef = ref<HTMLTextAreaElement | null>(null);
    const editorScrollRef = ref<HTMLDivElement | null>(null);
    const imageScaleMax = computed(() =>
      Math.min(IMAGE_SCALE_MAX, Math.max(IMAGE_SCALE_MIN, Math.floor(props.imageScaleMax))),
    );
    const imageScaleProgress = computed(() => {
      const range = imageScaleMax.value - IMAGE_SCALE_MIN;
      return range > 0
        ? ((props.state.imageScale - IMAGE_SCALE_MIN) / range) * 100
        : 100;
    });
    const copyState = ref<"idle" | "copied" | "error">("idle");
    const exportTimeSource = shallowRef<"configured" | "current">("configured");
    const textFormatMenu = ref<{
      left: number;
      top: number;
      selectionStart: number;
      selectionEnd: number;
    } | null>(null);
    const hasTextSelection = shallowRef(false);
    let lastTextPointer: { type: string; time: number } | null = null;
    let copyStateTimer: number | undefined;
    let textAreaAnchorFrame: number | undefined;
    let measuredTextLength = props.state.text.length;
    let hasMeasuredTextAreaHeight = false;
    const stopTextAreaAnchor = () => {
      if (textAreaAnchorFrame === undefined) return;
      window.cancelAnimationFrame(textAreaAnchorFrame);
      textAreaAnchorFrame = undefined;
    };
    const keepTextAreaBottomAnchored = (scroller: HTMLDivElement, bottomGap: number) => {
      stopTextAreaAnchor();
      const expiresAt = performance.now() + TEXTAREA_HEIGHT_ANCHOR_MS;
      const anchor = () => {
        scroller.scrollTop = Math.max(
          0,
          scroller.scrollHeight - scroller.clientHeight - bottomGap,
        );
        if (performance.now() < expiresAt) {
          textAreaAnchorFrame = window.requestAnimationFrame(anchor);
        } else {
          textAreaAnchorFrame = undefined;
        }
      };
      anchor();
    };
    const syncTextAreaHeight = (force = false) => {
      const textArea = textAreaRef.value;
      if (!textArea) return;
      const nextTextLength = props.state.text.length;
      const stillFits = textArea.scrollHeight <= textArea.clientHeight + 1;
      if (
        !force &&
        hasMeasuredTextAreaHeight &&
        nextTextLength > measuredTextLength &&
        stillFits
      ) {
        measuredTextLength = nextTextLength;
        textArea.scrollTop = 0;
        return;
      }

      const scroller = editorScrollRef.value;
      const bottomGap = scroller
        ? Math.max(0, scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight)
        : null;
      const keepBottomAnchored = bottomGap !== null && bottomGap <= 80;

      const currentHeight = textArea.getBoundingClientRect().height;
      textArea.style.height = "auto";
      const nextHeight = Math.max(
        textArea.scrollHeight + 2,
        TEXTAREA_MIN_HEIGHT,
      );
      const shouldAnimate =
        hasMeasuredTextAreaHeight &&
        currentHeight > 0 &&
        Math.abs(nextHeight - currentHeight) > 0.5 &&
        !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

      if (shouldAnimate) {
        textArea.style.height = `${currentHeight}px`;
        void textArea.offsetHeight;
        textArea.style.height = `${nextHeight}px`;
      } else {
        textArea.style.transition = "none";
        textArea.style.height = `${nextHeight}px`;
        void textArea.offsetHeight;
        textArea.style.transition = "";
      }
      textArea.scrollTop = 0;
      measuredTextLength = nextTextLength;
      hasMeasuredTextAreaHeight = true;

      if (scroller && keepBottomAnchored) {
        if (shouldAnimate) keepTextAreaBottomAnchored(scroller, bottomGap ?? 0);
        else {
          scroller.scrollTop = Math.max(
            0,
            scroller.scrollHeight - scroller.clientHeight - (bottomGap ?? 0),
          );
        }
      }
    };
    const refreshTextAreaHeight = () => syncTextAreaHeight(true);
    onMounted(() => {
      syncTextAreaHeight(true);
      window.addEventListener("resize", refreshTextAreaHeight);
    });
    onBeforeUnmount(() => {
      window.removeEventListener("resize", refreshTextAreaHeight);
      stopTextAreaAnchor();
      if (copyStateTimer) window.clearTimeout(copyStateTimer);
    });
    watch(
      () => props.state.text,
      () => nextTick(syncTextAreaHeight),
      { flush: "post" },
    );

    const textPast = ref<string[]>([]);
    const textFuture = ref<string[]>([]);
    watch(() => props.historyResetToken, () => {
      textPast.value = [];
      textFuture.value = [];
    });
    const commitText = (nextText: string) => {
      if (nextText === props.state.text) return;
      textPast.value = [...textPast.value.slice(-79), props.state.text];
      textFuture.value = [];
      props.update("text", nextText);
    };
    const focusSelection = (start: number, end = start) => {
      requestAnimationFrame(() => {
        const area = textAreaRef.value;
        if (!area) return;
        area.focus();
        area.setSelectionRange(start, end);
        hasTextSelection.value = start !== end;
      });
    };
    const undoText = () => {
      const previous = textPast.value.at(-1);
      if (previous === undefined) return;
      textPast.value = textPast.value.slice(0, -1);
      textFuture.value = [props.state.text, ...textFuture.value].slice(0, 80);
      props.update("text", previous);
      focusSelection(previous.length);
    };
    const redoText = () => {
      const next = textFuture.value[0];
      if (next === undefined) return;
      textFuture.value = textFuture.value.slice(1);
      textPast.value = [...textPast.value.slice(-79), props.state.text];
      props.update("text", next);
      focusSelection(next.length);
    };
    const replaceSelection = (
      nextText: string,
      selectionStart: number,
      selectionEnd = selectionStart,
    ) => {
      commitText(nextText);
      focusSelection(selectionStart, selectionEnd);
    };
    const applyInlineFormat = (marker: "**" | "*") => {
      const area = textAreaRef.value;
      if (!area) return;
      const { selectionStart: start, selectionEnd: end } = area;
      const selection = props.state.text.slice(start, end),
        before = props.state.text.slice(0, start),
        after = props.state.text.slice(end);
      if (before.endsWith(marker) && after.startsWith(marker)) {
        replaceSelection(
          `${before.slice(0, -marker.length)}${selection}${after.slice(marker.length)}`,
          start - marker.length,
          end - marker.length,
        );
        return;
      }
      replaceSelection(
        `${before}${marker}${selection}${marker}${after}`,
        start + marker.length,
        end + marker.length,
      );
    };
    const applyLineFormat = (kind: LineFormat) => {
      const area = textAreaRef.value;
      if (!area) return;
      const { selectionStart: start, selectionEnd: end } = area;
      const lineStart =
        props.state.text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      const lineEndIndex = props.state.text.indexOf("\n", end);
      const lineEnd =
        lineEndIndex === -1 ? props.state.text.length : lineEndIndex;
      const selectedLines = props.state.text
        .slice(lineStart, lineEnd)
        .split("\n");
      const headingLevel = kind.startsWith("heading") ? Number(kind.at(-1)) : 0;
      const headingPattern = /^(#{1,3})\s+/,
        quotePattern = /^>\s?/,
        unorderedListPattern = /^[-*+•]\s+/,
        orderedListPattern = /^\d+[.)]\s+/,
        anyListPattern = /^(?:[-*+•]\s+|\d+[.)]\s+)/;
      let nextLines = selectedLines;
      if (headingLevel) {
        const marker = `${"#".repeat(headingLevel)} `;
        const all = selectedLines.every((line) => line.startsWith(marker));
        nextLines = selectedLines.map((line) =>
          all
            ? line.slice(marker.length)
            : `${marker}${line.replace(headingPattern, "")}`,
        );
      } else if (kind === "quote") {
        const all = selectedLines.every(
          (line) => !line.trim() || quotePattern.test(line),
        );
        nextLines = selectedLines.map((line) =>
          all ? line.replace(quotePattern, "") : `> ${line}`,
        );
      } else if (kind === "unordered-list") {
        const nonEmptyLines = selectedLines.filter((line) => line.trim());
        const all = nonEmptyLines.length > 0 && nonEmptyLines.every((line) => unorderedListPattern.test(line));
        nextLines = selectedLines.map((line) => {
          if (!line.trim()) return line;
          return all ? line.replace(unorderedListPattern, "") : `• ${line.replace(anyListPattern, "")}`;
        });
      } else if (kind === "ordered-list") {
        const nonEmptyLines = selectedLines.filter((line) => line.trim());
        const all = nonEmptyLines.length > 0 && nonEmptyLines.every((line) => orderedListPattern.test(line));
        let itemNumber = 1;
        nextLines = selectedLines.map((line) => {
          if (all) return line.replace(orderedListPattern, "");
          const prefix = `${itemNumber}. `;
          itemNumber += 1;
          return `${prefix}${line.replace(anyListPattern, "")}`;
        });
      }
      const replacement = nextLines.join("\n");
      replaceSelection(
        `${props.state.text.slice(0, lineStart)}${replacement}${props.state.text.slice(lineEnd)}`,
        lineStart,
        lineStart + replacement.length,
      );
    };
    const onTextKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redoText();
        else undoText();
      } else if (key === "y") {
        event.preventDefault();
        redoText();
      } else if (key === "b") {
        event.preventDefault();
        applyInlineFormat("**");
      } else if (key === "i") {
        event.preventDefault();
        applyInlineFormat("*");
      } else if (key === "1" || key === "3") {
        event.preventDefault();
        applyLineFormat(`heading-${key}` as LineFormat);
      } else if (event.shiftKey && key === "q") {
        event.preventDefault();
        applyLineFormat("quote");
      }
    };
    const onTextInput = (event: Event) => commitText((event.target as HTMLTextAreaElement).value);
    const copyBodyText = async () => {
      const plainText = markdownToPlainText(props.state.text);
      if (!plainText || !navigator.clipboard?.writeText) return;
      try {
        await navigator.clipboard.writeText(plainText);
        copyState.value = "copied";
      } catch {
        copyState.value = "error";
      }
      if (copyStateTimer) window.clearTimeout(copyStateTimer);
      copyStateTimer = window.setTimeout(() => (copyState.value = "idle"), 1800);
    };
    const startNewPage = () => {
      const area = textAreaRef.value;
      if (!area) return;
      // A page break is inserted, never substituted for a selection. This
      // keeps all authored text intact even when a range is highlighted.
      const start = area.selectionStart;
      const before = props.state.text.slice(0, start);
      const after = props.state.text.slice(start);
      const marker = `\n\n${PAGE_BREAK_MARKER}\n\n`;
      replaceSelection(
        `${before}${marker}${after}`,
        start + marker.length,
      );
    };
    const closeTextFormatMenu = () => {
      textFormatMenu.value = null;
    };
    const dismissTextFormatMenu = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (target instanceof Element && target.closest(".text-context-menu")) return;
      closeTextFormatMenu();
    };
    const dismissTextFormatMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeTextFormatMenu();
    };
    const openTextFormatMenu = (event: MouseEvent) => {
      const area = textAreaRef.value;
      if (!area) return;
      const viewportPadding = 8;
      const menuWidth = Math.min(248, window.innerWidth - viewportPadding * 2);
      const menuHeight = Math.min(472, window.innerHeight - viewportPadding * 2);
      const areaBounds = area.getBoundingClientRect();
      const clientX = event.clientX || areaBounds.left + 16;
      const clientY = event.clientY || areaBounds.top + 16;
      textFormatMenu.value = {
        left: Math.max(viewportPadding, Math.min(clientX, window.innerWidth - menuWidth - viewportPadding)),
        top: Math.max(viewportPadding, Math.min(clientY, window.innerHeight - menuHeight - viewportPadding)),
        selectionStart: area.selectionStart,
        selectionEnd: area.selectionEnd,
      };
    };
    const openTextFormatMenuOnContext = (event: MouseEvent) => {
      const pointerType = typeof PointerEvent !== "undefined" && event instanceof PointerEvent ? event.pointerType : "";
      const recentTouch = lastTextPointer?.type === "touch" && performance.now() - lastTextPointer.time < 2000;
      if (pointerType === "touch" || recentTouch || (!pointerType && !lastTextPointer && window.matchMedia("(hover: none) and (pointer: coarse)").matches)) {
        closeTextFormatMenu();
        return;
      }
      event.preventDefault();
      openTextFormatMenu(event);
    };
    const currentTextSelection = () => {
      const area = textAreaRef.value;
      if (!area) return null;
      return textFormatMenu.value ?? {
        selectionStart: area.selectionStart,
        selectionEnd: area.selectionEnd,
      };
    };
    const runTextFormatAction = (action: "undo" | "redo" | "bold" | "italic" | "heading" | "quote" | "unordered-list" | "ordered-list") => {
      const menu = textFormatMenu.value;
      const area = textAreaRef.value;
      if (menu && area) {
        area.focus();
        area.setSelectionRange(menu.selectionStart, menu.selectionEnd);
      }
      if (action === "undo") undoText();
      else if (action === "redo") redoText();
      else if (action === "bold") applyInlineFormat("**");
      else if (action === "italic") applyInlineFormat("*");
      else if (action === "heading") applyLineFormat("heading-1");
      else if (action === "quote") applyLineFormat("quote");
      else applyLineFormat(action);
      closeTextFormatMenu();
    };
    const copyTextSelection = async () => {
      const selection = currentTextSelection();
      if (!selection || selection.selectionStart === selection.selectionEnd || !navigator.clipboard?.writeText) return;
      try {
        await navigator.clipboard.writeText(props.state.text.slice(selection.selectionStart, selection.selectionEnd));
        closeTextFormatMenu();
      } catch {
        // Clipboard access can be denied by the browser; keep the menu open.
      }
    };
    const cutTextSelection = async () => {
      const selection = currentTextSelection();
      if (!selection || selection.selectionStart === selection.selectionEnd || !navigator.clipboard?.writeText) return;
      try {
        await navigator.clipboard.writeText(props.state.text.slice(selection.selectionStart, selection.selectionEnd));
        replaceSelection(
          `${props.state.text.slice(0, selection.selectionStart)}${props.state.text.slice(selection.selectionEnd)}`,
          selection.selectionStart,
        );
        closeTextFormatMenu();
      } catch {
        // Do not remove text unless it was successfully copied.
      }
    };
    const pasteTextSelection = async () => {
      const selection = currentTextSelection();
      if (!selection || !navigator.clipboard?.readText) return;
      try {
        const clipboardText = await navigator.clipboard.readText();
        replaceSelection(
          `${props.state.text.slice(0, selection.selectionStart)}${clipboardText}${props.state.text.slice(selection.selectionEnd)}`,
          selection.selectionStart + clipboardText.length,
        );
        closeTextFormatMenu();
      } catch {
        // Clipboard access can be denied by the browser; keep the menu open.
      }
    };
    onMounted(() => {
      document.addEventListener("pointerdown", dismissTextFormatMenu);
      document.addEventListener("keydown", dismissTextFormatMenuOnEscape);
    });
    onBeforeUnmount(() => {
      document.removeEventListener("pointerdown", dismissTextFormatMenu);
      document.removeEventListener("keydown", dismissTextFormatMenuOnEscape);
    });
    const setInput =
      <K extends keyof BymarkState>(key: K) =>
      (event: Event) =>
        props.update(
          key,
          (event.target as HTMLInputElement).value as BymarkState[K],
        );
    const countChinese = () => countChineseCharacters(props.state.text);
    const countTotal = () => countCharacters(props.state.text);
    const readingMinutes = () => {
      const chinese = countChinese();
      const words = props.state.text.replace(/[\p{Script=Han}]/gu, " ").trim().split(/\s+/).filter(Boolean).length;
      return Math.max(1, Math.ceil(chinese / 300 + words / 220));
    };
    const activeTab = ref<EditorTab>("content");
    const titleSettingsOpen = ref(false);
    const exportOpen = ref(false);
    const tabScrollPositions: Record<EditorTab, number> = {
      content: 0,
      layout: 0,
      publish: 0,
    };
    const selectTab = (tab: EditorTab) => {
      const scroller = editorScrollRef.value;
      if (scroller) tabScrollPositions[activeTab.value] = scroller.scrollTop;
      exportOpen.value = false;
      activeTab.value = tab;
      nextTick(() => {
        if (editorScrollRef.value) editorScrollRef.value.scrollTop = tabScrollPositions[tab];
        if (tab === "content") syncTextAreaHeight(true);
      });
    };
    const densityOptions = [
      { label: "舒展", value: 106 },
      { label: "标准", value: 100 },
      { label: "紧凑", value: 92 },
    ];
    const activeDensityValue = () => densityOptions.find((option) => props.state.fontScale === option.value)?.value ?? null;

    return () => (
      <aside id="mobile-editor-panel" class="editor-panel">
        <header class="brand-lockup">
          <img class="brand-mark" src="/icon-192.png" width="32" height="32" alt="留印图标" />
          <div class="brand-copy">
            <h1>留印</h1>
            <UpdateIndicator />
          </div>
          <ThemeToggle theme={props.state.theme} onChange={(theme) => props.update("theme", theme)} />
          <button type="button" class="archive-nav-button" onClick={props.onOpenArchive} aria-label="打开归档" title="打开归档">
            <Archive size={17} aria-hidden="true" />
          </button>
        </header>

        <nav class={["editor-tabs", `editor-tabs-active-${activeTab.value}`]} role="tablist" aria-label="编辑面板">
          <span class="editor-tabs-indicator" aria-hidden="true" />
          {([
            ["content", "内容", FileText],
            ["layout", "版式", SlidersHorizontal],
            ["publish", "导出", Send],
          ] as const).map(([tab, label, Icon]) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab.value === tab}
              aria-controls={`editor-tab-${tab}`}
              onClick={() => selectTab(tab)}
            >
              <Icon size={15} aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>

        <div ref={editorScrollRef} class="editor-groups editor-tab-scroll">
          {activeTab.value === "content" && (
            <section id="editor-tab-content" class="editor-tab-panel" role="tabpanel">
              <div class="content-editor-header">
                <div class="label-line content-label-line">
                  <label class="field-label" for="bymark-text">正文</label>
                  <span
                    class="text-metrics"
                    data-testid="text-metrics"
                    aria-label={`共 ${countTotal()} 个字符，预计阅读 ${readingMinutes()} 分钟`}
                  >
                    <b>{countTotal()} 字符</b>
                    <i aria-hidden="true" />
                    <span>约 {readingMinutes()} 分钟</span>
                  </span>
                </div>
                <div class="markdown-toolbar" role="toolbar" aria-label="正文编辑工具">
                  <button class="icon-tooltip icon-tooltip-start" type="button" aria-label="撤销" data-tooltip="撤销（⌘/Ctrl + Z）" disabled={textPast.value.length === 0} onClick={undoText}>
                    <Undo2 size={15} />
                  </button>
                  <button class="icon-tooltip" type="button" aria-label="重做" data-tooltip="重做（⌘/Ctrl + Shift + Z）" disabled={textFuture.value.length === 0} onClick={redoText}>
                    <Redo2 size={15} />
                  </button>
                  <span aria-hidden="true" />
                  <button class="icon-tooltip" type="button" aria-label="剪切" data-tooltip="剪切（⌘/Ctrl + X）" disabled={!hasTextSelection.value || !navigator.clipboard?.writeText} onClick={cutTextSelection}>
                    <Scissors size={15} />
                  </button>
                  <button class="icon-tooltip" type="button" aria-label="复制" data-tooltip="复制（⌘/Ctrl + C）" disabled={!hasTextSelection.value || !navigator.clipboard?.writeText} onClick={copyTextSelection}>
                    <Copy size={15} />
                  </button>
                  <button class="icon-tooltip" type="button" aria-label="粘贴" data-tooltip="粘贴（⌘/Ctrl + V）" disabled={!navigator.clipboard?.readText} onClick={pasteTextSelection}>
                    <ClipboardPaste size={15} />
                  </button>
                  <span aria-hidden="true" />
                  <button class="icon-tooltip" type="button" aria-label="加粗" data-tooltip="加粗（⌘/Ctrl + B）" onClick={() => applyInlineFormat("**")}>
                    <Bold size={15} />
                  </button>
                  <button class="icon-tooltip" type="button" aria-label="斜体" data-tooltip="斜体（⌘/Ctrl + I）" onClick={() => applyInlineFormat("*")}>
                    <Italic size={15} />
                  </button>
                  <span aria-hidden="true" />
                  <button class="icon-tooltip" type="button" aria-label="一级标题" data-tooltip="一级标题（⌘/Ctrl + 1）" onClick={() => applyLineFormat("heading-1")}>
                    <Heading1 size={16} />
                  </button>
                  <button class="icon-tooltip" type="button" aria-label="引用" data-tooltip="引用（⌘/Ctrl + Shift + Q）" onClick={() => applyLineFormat("quote")}>
                    <Quote size={15} />
                  </button>
                  <button class="icon-tooltip" type="button" aria-label="无序列表" data-tooltip="无序列表" onClick={() => applyLineFormat("unordered-list")}>
                    <List size={15} />
                  </button>
                  <button class="icon-tooltip" type="button" aria-label="有序列表" data-tooltip="有序列表" onClick={() => applyLineFormat("ordered-list")}>
                    <ListOrdered size={15} />
                  </button>
                  <span aria-hidden="true" />
                  <button
                    class="insert-page-break"
                    type="button"
                    aria-label="从光标处另起一页"
                    title="从当前光标位置开始新的一页"
                    onClick={startNewPage}
                  >
                    <Rows3 size={15} aria-hidden="true" /> 另起一页
                  </button>
                </div>
              </div>
              <div class={["text-area-wrap", "input-focus-frame", props.overflowing && "input-focus-frame-warning"]}>
                <textarea
                  ref={textAreaRef}
                  id="bymark-text"
                  class={["control", "text-control", props.overflowing && "control-warning"]}
                  value={props.state.text}
                  onInput={onTextInput}
                  onKeydown={onTextKeyDown}
                  onSelect={(event: Event) => {
                    const area = event.currentTarget as HTMLTextAreaElement;
                    hasTextSelection.value = area.selectionStart !== area.selectionEnd;
                  }}
                  onPointerdown={(event: PointerEvent) => {
                    lastTextPointer = { type: event.pointerType, time: performance.now() };
                  }}
                  onTouchstart={() => {
                    lastTextPointer = { type: "touch", time: performance.now() };
                  }}
                  onContextmenu={openTextFormatMenuOnContext}
                  placeholder="在这里留下你的文字。"
                  rows={9}
                  spellcheck={false}
                />
                {props.state.text.trim() && (
                  <button
                    type="button"
                    class={[
                      "copy-body-button",
                      copyState.value === "copied" && "copy-body-button-success",
                      copyState.value === "error" && "copy-body-button-error",
                    ]}
                    onClick={copyBodyText}
                    aria-label="复制正文（不含 Markdown 格式）"
                    title="复制正文（不含 Markdown 格式）"
                  >
                    <Copy size={14} />
                    {copyState.value === "copied" ? "已复制" : copyState.value === "error" ? "复制失败" : "复制正文"}
                  </button>
                )}
              </div>
              <section class={["work-title-details", titleSettingsOpen.value && "work-title-details-open"]}>
                <button
                  type="button"
                  class="work-title-toggle"
                  aria-expanded={titleSettingsOpen.value}
                  aria-controls="bymark-title-panel"
                  onClick={() => (titleSettingsOpen.value = !titleSettingsOpen.value)}
                >
                  <span>作品标题</span>
                  <small>可选</small>
                </button>
                <div id="bymark-title-panel" class="work-title-panel" aria-hidden={!titleSettingsOpen.value}>
                  <div class="work-title-panel-inner">
                    <div class="work-title-field">
                      <div class="input-focus-frame work-title-input-frame">
                        <input
                          ref={titleInputRef}
                          id="bymark-title"
                          class="control work-title-input"
                          value={props.state.title}
                          maxlength={WORK_TITLE_MAX_LENGTH}
                          placeholder="留空时取正文首行"
                          aria-label="作品标题"
                          tabindex={titleSettingsOpen.value ? 0 : -1}
                          onInput={setInput("title")}
                          onKeydown={(event: KeyboardEvent) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            textAreaRef.value?.focus();
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </section>
              <LayoutReveal show={props.state.visualStyle === "folio"}>
                <SocialMetricsControls state={props.state} update={props.update} />
              </LayoutReveal>
              <LayoutReveal show={props.overflowing}>
                <button type="button" class="overflow-action" onClick={() => selectTab("layout")}>
                  当前页内容过密，前往版式调整
                </button>
              </LayoutReveal>
            </section>
          )}

          {activeTab.value === "layout" && (
            <section id="editor-tab-layout" class="editor-tab-panel" role="tabpanel">
              <div class="settings-group settings-group-first">
                <div class="settings-heading">
                  <h2>版式</h2>
                </div>
                <div class="visual-style-picker" role="group" aria-label="版式">
                  <button
                    type="button"
                    class={props.state.visualStyle === "default" ? "active" : ""}
                    aria-pressed={props.state.visualStyle === "default"}
                    onClick={() => props.update("visualStyle", "default")}
                  >
                    Bymark
                  </button>
                  <button
                    type="button"
                    class={props.state.visualStyle === "folio" ? "active" : ""}
                    aria-pressed={props.state.visualStyle === "folio"}
                    onClick={() => props.update("visualStyle", "folio")}
                  >
                    X
                  </button>
                </div>
              </div>

              <div class="settings-group">
                <div class="settings-heading"><h2>布局</h2></div>
                <div class="theme-picker" role="group" aria-label="布局">
                  <button
                    type="button"
                    class={props.state.canvasStyle === "card" ? "active" : ""}
                    aria-pressed={props.state.canvasStyle === "card"}
                    onClick={() => props.update("canvasStyle", "card")}
                  >
                    铺满
                  </button>
                  <button
                    type="button"
                    class={props.state.canvasStyle === "scene" ? "active" : ""}
                    aria-pressed={props.state.canvasStyle === "scene"}
                    onClick={() => props.update("canvasStyle", "scene")}
                  >
                    悬浮
                  </button>
                </div>
                <LayoutReveal show={props.state.canvasStyle === "scene"}>
                  <BackdropControls
                    state={props.state}
                    update={props.update}
                    sceneImage={props.sceneImage}
                    onSceneImageFile={props.onSceneImageFile}
                    onRemoveSceneImage={props.onRemoveSceneImage}
                    showCardGeometry
                  />
                </LayoutReveal>
              </div>

              <div class="settings-group">
                <div class="settings-heading">
                  <h2>画幅</h2>
                </div>
                <div class="ratio-segmented" role="group" aria-label="画幅与平台">
                  {ASPECT_PRESETS.map((preset) => (
                    <button
                      key={preset.ratio}
                      type="button"
                      aria-label={`${preset.ratio} · ${preset.name}`}
                      class={props.state.exportMode === "standard" && props.state.ratio === preset.ratio ? "active" : ""}
                      onClick={() => {
                        props.update("ratio", preset.ratio);
                        props.update("exportMode", "standard");
                      }}
                    >
                      {preset.ratio}
                    </button>
                  ))}
                  <button
                    type="button"
                    aria-label="封面 · 导出为 9:16，经过抖音封面裁切后适配 3:4"
                    class={props.state.exportMode === "douyin-cover" ? "active" : ""}
                    onClick={() => {
                      props.update("ratio", "9:16");
                      props.update("exportMode", "douyin-cover");
                    }}
                  >
                    封面
                  </button>
                </div>
                <p class="setting-summary">
                  {props.state.exportMode === "douyin-cover"
                    ? "导出为 9:16，经过抖音封面裁切后适配 3:4，为了修改旧作品的封面"
                    : ASPECT_PRESETS.find((preset) => preset.ratio === props.state.ratio)?.description}
                </p>
              </div>

              <div class="settings-group">
                <div class="settings-heading"><h2>排版</h2></div>
                <div class={[
                  "density-picker",
                  activeDensityValue() ? `density-picker-active-${activeDensityValue()}` : "density-picker-custom",
                ]} role="group" aria-label="常用字体大小">
                  <span class="density-picker-indicator" aria-hidden="true" />
                  {densityOptions.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      class={props.state.fontScale === option.value ? "active" : ""}
                      aria-label={`${option.label} ${option.value}%`}
                      aria-pressed={props.state.fontScale === option.value}
                      onClick={() => props.update("fontScale", option.value)}
                    >
                      <strong>{option.label}</strong>
                    </button>
                  ))}
                </div>
                <SettingsDisclosure
                  id="bymark-advanced-type"
                  label="高级"
                  summary={`字号 ${props.state.fontScale}% · 行高 ${props.state.lineHeightScale}%`}
                >
                  <div class="type-scale-setting type-scale-setting-advanced">
                    <div class="font-scale-header">
                      <label class="field-label" for="bymark-font-scale">字号</label>
                    </div>
                    <div class="font-scale-control font-scale-control-compact" style={{ "--font-progress": `${(props.state.fontScale / 200) * 100}%` } as Record<string, string>}>
                      <button
                        type="button"
                        class="scale-step"
                        aria-label="字体缩小 1%"
                        title="字体缩小 1%"
                        disabled={props.state.fontScale <= 0}
                        onClick={() => props.update("fontScale", Math.max(0, props.state.fontScale - 1))}
                      >
                        <Minus size={14} aria-hidden="true" />
                      </button>
                      <input
                        id="bymark-font-scale"
                        type="range"
                        min="0"
                        max="200"
                        step="1"
                        value={props.state.fontScale}
                        onInput={(event) => props.update("fontScale", Number((event.target as HTMLInputElement).value))}
                        aria-valuetext={`${props.state.fontScale}%`}
                      />
                      <button
                        type="button"
                        class="scale-step"
                        aria-label="字体放大 1%"
                        title="字体放大 1%"
                        disabled={props.state.fontScale >= 200}
                        onClick={() => props.update("fontScale", Math.min(200, props.state.fontScale + 1))}
                      >
                        <Plus size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  <div class="type-scale-setting">
                    <div class="font-scale-header line-height-header">
                      <label class="field-label" for="bymark-line-height-scale">行高</label>
                    </div>
                    <div
                      class="line-height-control"
                      style={{ "--line-height-progress": `${((props.state.lineHeightScale - 80) / 80) * 100}%` } as Record<string, string>}
                    >
                      <button
                        type="button"
                        class="scale-step"
                        aria-label="行高减小 1%"
                        title="行高减小 1%"
                        disabled={props.state.lineHeightScale <= 80}
                        onClick={() => props.update("lineHeightScale", Math.max(80, props.state.lineHeightScale - 1))}
                      >
                        <Minus size={14} aria-hidden="true" />
                      </button>
                      <input
                        id="bymark-line-height-scale"
                        type="range"
                        min="80"
                        max="160"
                        step="1"
                        value={props.state.lineHeightScale}
                        onInput={(event) => props.update("lineHeightScale", Number((event.target as HTMLInputElement).value))}
                        aria-valuetext={`${props.state.lineHeightScale}%`}
                      />
                      <button
                        type="button"
                        class="scale-step"
                        aria-label="行高增加 1%"
                        title="行高增加 1%"
                        disabled={props.state.lineHeightScale >= 160}
                        onClick={() => props.update("lineHeightScale", Math.min(160, props.state.lineHeightScale + 1))}
                      >
                        <Plus size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </SettingsDisclosure>
                <LayoutReveal show={props.overflowing}>
                  <p class="field-warning">当前页内容过密，可缩小文字或调整行高。</p>
                </LayoutReveal>
              </div>

              <div class="settings-group">
                <div class="settings-heading"><h2>配图</h2></div>
                <UploadField value={props.image} kind="image" onFile={props.onImageFile} onRemove={props.onRemoveImage} />
                <LayoutReveal show={Boolean(props.image)} class="image-settings-details">
                  <SettingsDisclosure
                    id="bymark-image-layout"
                    label="图片布局"
                    summary={`${props.state.imagePosition === "above" ? "文字上方" : "文字下方"} · ${props.state.imageAlignment === "left" ? "左对齐" : "居中"} · ${props.state.imageScale}%`}
                  >
                    <div class="image-choice-grid">
                      <div class="image-choice-field">
                        <label class="field-label">配图位置</label>
                        <div class="theme-picker image-position-picker" role="group" aria-label="配图位置">
                          <button type="button" class={props.state.imagePosition === "above" ? "active" : ""} aria-pressed={props.state.imagePosition === "above"} onClick={() => props.update("imagePosition", "above")}>文字上方</button>
                          <button type="button" class={props.state.imagePosition === "below" ? "active" : ""} aria-pressed={props.state.imagePosition === "below"} onClick={() => props.update("imagePosition", "below")}>文字下方</button>
                        </div>
                      </div>
                      <div class="image-choice-field">
                        <label class="field-label">图片对齐</label>
                        <div class="theme-picker image-position-picker" role="group" aria-label="图片对齐">
                          <button type="button" class={props.state.imageAlignment === "left" ? "active" : ""} aria-pressed={props.state.imageAlignment === "left"} onClick={() => props.update("imageAlignment", "left")}>左对齐</button>
                          <button type="button" class={props.state.imageAlignment === "center" ? "active" : ""} aria-pressed={props.state.imageAlignment === "center"} onClick={() => props.update("imageAlignment", "center")}>居中</button>
                        </div>
                      </div>
                    </div>
                    <div class="image-scale-setting">
                      <div class="range-label image-scale-header">
                        <label class="field-label" for="bymark-image-scale">图片缩放</label>
                      </div>
                      <div class="image-scale-control" style={{ "--image-scale-progress": `${imageScaleProgress.value}%` } as Record<string, string>}>
                        <button
                          type="button"
                          class="scale-step"
                          aria-label="图片缩小 1%"
                          title="图片缩小 1%"
                          disabled={props.state.imageScale <= IMAGE_SCALE_MIN}
                          onClick={() => props.update("imageScale", Math.max(IMAGE_SCALE_MIN, props.state.imageScale - 1))}
                        >
                          <Minus size={14} aria-hidden="true" />
                        </button>
                        <input
                          id="bymark-image-scale"
                          type="range"
                          min={IMAGE_SCALE_MIN}
                          max={imageScaleMax.value}
                          step="1"
                          value={props.state.imageScale}
                          onInput={(event) => props.update("imageScale", Number((event.target as HTMLInputElement).value))}
                          aria-valuetext={`${props.state.imageScale}%`}
                        />
                        <button
                          type="button"
                          class="scale-step"
                          aria-label="图片放大 1%"
                          title="图片放大 1%"
                          disabled={props.state.imageScale >= imageScaleMax.value}
                          onClick={() => props.update("imageScale", Math.min(imageScaleMax.value, props.state.imageScale + 1))}
                        >
                          <Plus size={14} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  </SettingsDisclosure>
                </LayoutReveal>
              </div>

              <BrandTemplateLibrary
                templates={props.brandTemplates}
                loading={props.templatesLoading}
                busy={props.templatesPending}
                onSave={props.onSaveBrand}
                onUse={props.onUseBrand}
                onDelete={props.onDeleteBrand}
              />
            </section>
          )}

          {activeTab.value === "publish" && (
            <section id="editor-tab-publish" class="editor-tab-panel" role="tabpanel">
              <div class="settings-group settings-group-first">
                <div class="settings-heading"><h2>作者署名</h2></div>
                <label class="field-label">头像</label>
                <UploadField value={props.avatar} kind="avatar" onFile={props.onAvatarFile} onRemove={props.onRemoveAvatar} />
                <div class="field-pair">
                  <div>
                    <label class="field-label" for="bymark-name">昵称</label>
                    <input id="bymark-name" class="control" value={props.state.name} maxlength={32} onInput={setInput("name")} />
                  </div>
                  <div>
                    <label class="field-label" for="bymark-id">账号 ID</label>
                    <input id="bymark-id" class="control" value={props.state.userId} maxlength={36} onInput={setInput("userId")} />
                  </div>
                </div>
                <div class="signature-controls compact-setting-block">
                  <SwitchRow label="显示签名" ariaLabel="显示签名" checked={props.state.showSignature} onChange={(value) => props.update("showSignature", value)} />
                  <LayoutReveal show={props.state.showSignature}>
                    <div class="signature-details">
                      <label class="field-label" for="bymark-signature">签名文字</label>
                      <input
                        id="bymark-signature"
                        class="control"
                        aria-label="签名文字"
                        value={props.state.signature}
                        maxlength={36}
                        placeholder="留空时使用账号 ID"
                        onInput={setInput("signature")}
                      />
                    </div>
                  </LayoutReveal>
                </div>
              </div>

              <div class="settings-group">
                <div class="settings-heading"><h2>时间与地点</h2></div>
                <div class="meta-grid">
                  <div>
                    <div class="field-toggle-label">
                      <label for="bymark-time">时间</label>
                      <Toggle checked={props.state.showTime} onChange={(value) => props.update("showTime", value)} label="时间" />
                    </div>
                    <LayoutReveal show={props.state.showTime}>
                      <TimePicker value={props.state.time} onChange={(value) => props.update("time", value)} />
                    </LayoutReveal>
                  </div>
                  <div>
                    <div class="field-toggle-label">
                      <label for="bymark-date">日期</label>
                      <Toggle checked={props.state.showDate} onChange={(value) => props.update("showDate", value)} label="日期" />
                    </div>
                    <LayoutReveal show={props.state.showDate}>
                      <DatePicker value={props.state.date} onChange={(value) => props.update("date", value)} />
                    </LayoutReveal>
                  </div>
                </div>
                <LayoutReveal show={props.state.showTime || props.state.showDate}>
                  <button type="button" class="current-time-button" onClick={props.onCurrentTime}>
                    <Clock3 size={14} /> 使用当前时间
                  </button>
                </LayoutReveal>
                <div class="location-field">
                  <div class="field-toggle-label">
                    <label for="bymark-location">地点</label>
                    <Toggle checked={props.state.showLocation} onChange={(value) => props.update("showLocation", value)} label="地点" />
                  </div>
                  <LayoutReveal show={props.state.showLocation}>
                    <input id="bymark-location" class="control" value={props.state.location} maxlength={36} onInput={setInput("location")} />
                  </LayoutReveal>
                </div>
              </div>

            </section>
          )}
        </div>

        <div class={["export-dock", exportOpen.value && "export-dock-open"]}>
          <LayoutReveal show={exportOpen.value} overlay>
            <div id="export-options-panel" class="export-popover" aria-label="导出设置">
              <div class="export-quick-controls" aria-label="导出选项">
                <div class="export-segmented" role="group" aria-label="导出格式">
                  {(["png", "jpg"] as const).map((format) => (
                    <button
                      type="button"
                      key={format}
                      aria-label={format.toUpperCase()}
                      aria-pressed={props.exportFormat === format}
                      class={props.exportFormat === format ? "active" : ""}
                      onClick={() => props.onExportFormat(format)}
                    >
                      {format.toUpperCase()}
                    </button>
                  ))}
                </div>
                <div class="export-segmented export-resolution" role="group" aria-label="导出分辨率">
                  {([1024, 2048, 3072, 4096] as const).map((resolution) => (
                    <button
                      type="button"
                      key={resolution}
                      aria-label={`${resolution / 1024}K`}
                      aria-pressed={props.exportResolution === resolution}
                      class={props.exportResolution === resolution ? "active" : ""}
                      onClick={() => props.onExportResolution(resolution)}
                    >
                      {resolution / 1024}K
                    </button>
                  ))}
                </div>
              </div>
              <div class="export-time-setting" role="group" aria-label="导出时间">
                <span>导出时间</span>
                <div class="export-time-options">
                  <button
                    type="button"
                    class={exportTimeSource.value === "configured" ? "active" : ""}
                    aria-pressed={exportTimeSource.value === "configured"}
                    onClick={() => (exportTimeSource.value = "configured")}
                  >
                    已设置时间
                  </button>
                  <button
                    type="button"
                    class={exportTimeSource.value === "current" ? "active" : ""}
                    aria-pressed={exportTimeSource.value === "current"}
                    onClick={() => (exportTimeSource.value = "current")}
                  >
                    当前时间
                  </button>
                </div>
              </div>
              <div class="export-popover-footer">
                <span class="export-summary" title="文件大小为估算值，实际大小会因文字、配图和编码结果而变化。">
                  {props.pageCount > 1 ? `${props.pageCount} 页 · ` : ""}{props.exportEstimate.width} × {props.exportEstimate.height} · 约 {props.exportEstimate.estimate}
                </span>
                <button
                  type="button"
                  class="copy-image-button export-copy-button icon-tooltip"
                  aria-label="复制当前页图片"
                  data-tooltip="复制当前页为图片"
                  onClick={props.onCopyImage}
                  disabled={props.exporting || props.overflowing}
                >
                  <Copy size={14} /> 复制
                </button>
              </div>
            </div>
          </LayoutReveal>
          <div class="export-dock-bar">
            <button
              type="button"
              class="export-settings-button"
              aria-expanded={exportOpen.value}
              aria-controls="export-options-panel"
              onClick={() => (exportOpen.value = !exportOpen.value)}
            >
              <span>
                <strong>{props.exportResolution / 1024}K {props.exportFormat.toUpperCase()}</strong>
                <small>{props.exportEstimate.width} × {props.exportEstimate.height}</small>
              </span>
              {exportOpen.value ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
            <button type="button" class="archive-button" onClick={props.onArchive} disabled={props.overflowing}>
              <Archive size={15} />
              归档
            </button>
            <ExportButton
              status={props.exportStatus}
              progress={props.exportProgress}
              pageCount={props.pageCount}
              disabled={props.exporting || props.overflowing}
              onExport={() => props.onExport(exportTimeSource.value === "current")}
            />
          </div>
        </div>
        {textFormatMenu.value && (
          <Teleport to="body">
            <div
              class={["text-context-menu", `ui-${props.state.theme}`]}
              role="menu"
              aria-label="正文编辑菜单"
              style={{ left: `${textFormatMenu.value.left}px`, top: `${textFormatMenu.value.top}px` }}
              onPointerdown={(event: PointerEvent) => event.preventDefault()}
            >
              <div class="text-context-menu-group" role="group" aria-label="编辑">
                <button type="button" role="menuitem" disabled={textPast.value.length === 0} onClick={() => runTextFormatAction("undo")}><Undo2 size={16} /><span>撤销</span><kbd>⌘Z</kbd></button>
                <button type="button" role="menuitem" disabled={textFuture.value.length === 0} onClick={() => runTextFormatAction("redo")}><Redo2 size={16} /><span>重做</span><kbd>⇧⌘Z</kbd></button>
              </div>
              <div class="text-context-menu-separator" role="separator" />
              <div class="text-context-menu-group" role="group" aria-label="剪贴板">
                <button type="button" role="menuitem" disabled={textFormatMenu.value.selectionStart === textFormatMenu.value.selectionEnd} onClick={cutTextSelection}><Scissors size={16} /><span>剪切</span><kbd>⌘X</kbd></button>
                <button type="button" role="menuitem" disabled={textFormatMenu.value.selectionStart === textFormatMenu.value.selectionEnd} onClick={copyTextSelection}><Copy size={16} /><span>复制</span><kbd>⌘C</kbd></button>
                <button type="button" role="menuitem" disabled={!navigator.clipboard?.readText} onClick={pasteTextSelection}><ClipboardPaste size={16} /><span>粘贴</span><kbd>⌘V</kbd></button>
              </div>
              <div class="text-context-menu-separator" role="separator" />
              <div class="text-context-menu-group" role="group" aria-label="Markdown 格式">
                <button type="button" role="menuitem" onClick={() => runTextFormatAction("bold")}><Bold size={16} /><span>加粗</span><kbd>⌘B</kbd></button>
                <button type="button" role="menuitem" onClick={() => runTextFormatAction("italic")}><Italic size={16} /><span>斜体</span><kbd>⌘I</kbd></button>
                <button type="button" role="menuitem" onClick={() => runTextFormatAction("heading")}><Heading1 size={17} /><span>一级标题</span><kbd>⌘1</kbd></button>
                <button type="button" role="menuitem" onClick={() => runTextFormatAction("quote")}><Quote size={16} /><span>引用</span><kbd>⇧⌘Q</kbd></button>
                <button type="button" role="menuitem" onClick={() => runTextFormatAction("unordered-list")}><List size={16} /><span>无序列表</span></button>
                <button type="button" role="menuitem" onClick={() => runTextFormatAction("ordered-list")}><ListOrdered size={16} /><span>有序列表</span></button>
              </div>
            </div>
          </Teleport>
        )}
      </aside>
    );
  },
  {
    props: [
      "state",
      "update",
      "avatar",
      "image",
      "imageScaleMax",
      "sceneImage",
      "onAvatarFile",
      "onImageFile",
      "onSceneImageFile",
      "onRemoveAvatar",
      "onRemoveImage",
      "onRemoveSceneImage",
      "onCurrentTime",
      "brandTemplates",
      "templatesLoading",
      "templatesPending",
      "onSaveBrand",
      "onUseBrand",
      "onDeleteBrand",
      "exportFormat",
      "exportResolution",
      "exportEstimate",
      "onExportFormat",
      "onExportResolution",
      "onExport",
      "onArchive",
      "onOpenArchive",
      "onCopyImage",
      "exporting",
      "exportProgress",
      "exportStatus",
      "overflowing",
      "historyResetToken",
      "pageCount",
    ],
  },
);
