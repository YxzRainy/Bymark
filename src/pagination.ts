import type { BymarkState } from "./bymark";

export const PAGE_BREAK_MARKER = "<!-- bymark-page -->";

// Markdown renders the empty line between paragraphs as a full copy line.
// Keep its pagination cost close to the number of CJK glyphs that fit on one
// folio line; the previous half-line estimate let paragraph-heavy posts clip.
const PARAGRAPH_BREAK_WEIGHT = 28;

type PaginationOptions = Pick<BymarkState, "ratio" | "exportMode" | "fontScale" | "lineHeightScale" | "canvasStyle"> & {
  visualStyle?: BymarkState["visualStyle"];
  sceneCardRatio?: BymarkState["sceneCardRatio"];
  sceneCardHeight?: BymarkState["sceneCardHeight"];
  capacityScale?: number;
  hasImage: boolean;
};

export type PaginatedPage = {
  text: string;
  fillRatio: number;
  manualBreakBefore: boolean;
  sectionIndex: number;
  sourceOffset: number;
};

function textWeight(value: string) {
  return Array.from(value).reduce((total, character) => {
    if (character === "\n") return total + 8.5;
    if (/\s/u.test(character)) return total + 0.25;
    if (/\d/u.test(character)) return total + 0.68;
    if ((character.codePointAt(0) ?? 0) <= 0x7f) return total + 0.55;
    return total + 1;
  }, 0);
}

function blockWeight(block: string) {
  const lines = block.split("\n");
  const paragraphBreaks = block.match(/\n\n/g)?.length ?? 0;
  const structuralWeight = lines.reduce((total, line) => {
    if (/^#{1,3}\s+/.test(line)) return total + 22;
    if (/^(?:>|[-*+]|\d+[.)])\s+/.test(line)) return total + 7;
    return total;
  }, 0);
  // textWeight already counts both newline characters; add only the remainder
  // needed to make a rendered paragraph gap equal PARAGRAPH_BREAK_WEIGHT.
  const paragraphSpacingWeight = paragraphBreaks * (PARAGRAPH_BREAK_WEIGHT - 17);
  return textWeight(block) + structuralWeight + paragraphSpacingWeight;
}

function pageCapacity(options: PaginationOptions, pageIndex: number) {
  const base = options.exportMode === "douyin-cover"
    ? 270
    : { "3:4": 390, "2:3": 380, "9:16": 360 }[options.ratio];
  // A 0% slider value intentionally makes the preview text invisible; keep
  // pagination finite so that value remains safe to render and export.
  const copyBaseSize = options.canvasStyle === "scene" ? 21.84 : 19.32;
  // Capacity was calibrated against the original 30px body; compensate for
  // each visual style's actual base size so pagination follows rendered text.
  const fontFactor = Math.pow((30 * 100) / Math.max(1, options.fontScale * copyBaseSize), 1.85);
  const lineHeightFactor = 100 / (options.lineHeightScale ?? 100);
  const imageFactor = options.hasImage && pageIndex === 0 ? 0.48 : 1;
  // Folio reserves more of the canvas for its outer atmosphere, title strip
  // and inset footer than the free-position scene card does. A horizontal
  // 4:3 card still has room for a short two-paragraph post; 0.45 split those
  // posts despite the visibly unused space above the action row.
  const folioCardHeightFactor = options.sceneCardRatio === "4:3"
    ? 0.52
    : options.sceneCardRatio === "1:1"
      ? 0.7
      : 1;
  const sceneFactor = options.canvasStyle === "scene"
    ? options.visualStyle === "folio" ? 0.42 * folioCardHeightFactor : 0.62
    : 1;
  const sceneCardHeightFactor = options.canvasStyle === "scene"
    ? Math.min(1, Math.max(0.6, (options.sceneCardHeight ?? 100) / 100))
    : 1;
  // Start from the full usable card area. The rendered card reports a real
  // overflow back to App, which is the authority for the final page break;
  // keeping a large safety buffer here caused a visible empty line before
  // the next page for ordinary continuous text.
  const layoutSafetyFactor = 1.402;
  const capacityScale = Math.min(1, Math.max(0.35, options.capacityScale ?? 1));
  return Math.max(32, base * fontFactor * lineHeightFactor * imageFactor * sceneFactor * sceneCardHeightFactor * layoutSafetyFactor * capacityScale);
}

function pageFillRatio(text: string, options: PaginationOptions, pageIndex: number) {
  return Math.min(1, blockWeight(text) / pageCapacity(options, pageIndex));
}

function splitOnceNearCapacity(value: string, capacity: number) {
  if (blockWeight(value) <= capacity * 1.05) return [value.trim(), ""] as const;
  const characters = Array.from(value);
  let weight = 0;
  let cursor = 0;
  let preferredBreak = -1;

  while (cursor < characters.length) {
    const characterWeight = textWeight(characters[cursor]);
    if (cursor > 0 && weight + characterWeight > capacity) break;
    weight += characterWeight;
    cursor += 1;
    if (/[。！？；.!?;，,、：:\n\s]/u.test(characters[cursor - 1]) && weight >= capacity * 0.72) {
      preferredBreak = cursor;
    }
  }

  if (cursor >= characters.length) return [value.trim(), ""] as const;
  const end = preferredBreak > 0 ? preferredBreak : cursor;
  return [
    characters.slice(0, end).join("").trim(),
    characters.slice(end).join("").trim(),
  ] as const;
}

function splitNearCapacity(value: string, capacity: number) {
  const chunks: string[] = [];
  let remaining = value.trim();
  while (remaining) {
    const [chunk, tail] = splitOnceNearCapacity(remaining, capacity);
    if (!chunk) break;
    chunks.push(chunk);
    remaining = tail;
  }
  return chunks;
}

function blocksFor(source: string) {
  return source
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function paginateSection(source: string, options: PaginationOptions, pageOffset: number) {
  const pages: string[] = [];
  let current = "";
  let currentWeight = 0;

  const pushCurrent = () => {
    if (!current.trim()) return;
    pages.push(current.trim());
    current = "";
    currentWeight = 0;
  };

  for (const block of blocksFor(source)) {
    let parts = [block];
    let capacity = pageCapacity(options, pageOffset + pages.length);
    if (blockWeight(block) > capacity) parts = splitNearCapacity(block, capacity);

    for (const [partIndex, part] of parts.entries()) {
      let remaining = part;
      let needsSeparator = partIndex === 0;
      while (remaining) {
        capacity = pageCapacity(options, pageOffset + pages.length);
        const separatorWeight = current && needsSeparator ? PARAGRAPH_BREAK_WEIGHT : 0;
        const separator = current && needsSeparator ? "\n\n" : "";
        const available = capacity - currentWeight - separatorWeight;
        const weight = blockWeight(remaining);

        if (weight <= available) {
          current = current ? `${current}${separator}${remaining}` : remaining;
          currentWeight += separatorWeight + weight;
          break;
        }

        // A paragraph is allowed to continue on the next page. Moving it as an
        // indivisible block leaves a visibly empty lower half on the current page.
        if (current && available >= 40) {
          const [head, tail] = splitOnceNearCapacity(remaining, available);
          if (head && tail) {
            current = `${current}${separator}${head}`;
            currentWeight += separatorWeight + blockWeight(head);
            pushCurrent();
            needsSeparator = false;
            remaining = tail;
            continue;
          }
        }

        if (current) {
          pushCurrent();
          continue;
        }

        const [head, tail] = splitOnceNearCapacity(remaining, capacity);
        current = head;
        currentWeight = blockWeight(head);
        if (tail) {
          pushCurrent();
          needsSeparator = false;
          remaining = tail;
          continue;
        }
        break;
      }
    }
  }
  pushCurrent();
  return pages;
}

export function paginateMarkdown(source: string, options: PaginationOptions) {
  return paginateMarkdownDetailed(source, options).map((page) => page.text);
}

export function paginateMarkdownDetailed(source: string, options: PaginationOptions): PaginatedPage[] {
  const normalized = source.replace(/\r\n?/g, "\n");
  const sections = normalized.split(PAGE_BREAK_MARKER);
  const pages: PaginatedPage[] = [];
  let sectionSourceOffset = 0;

  sections.forEach((section, sectionIndex) => {
    const sectionPages = paginateSection(section, options, pages.length);
    const resolvedPages = sectionPages.length ? sectionPages : sections.length > 1 ? [""] : [];
    let searchOffset = 0;

    resolvedPages.forEach((text, sectionPageIndex) => {
      const locatedAt = text ? section.indexOf(text, searchOffset) : searchOffset;
      const offsetInSection = locatedAt >= 0 ? locatedAt : searchOffset;
      const pageIndex = pages.length;
      pages.push({
        text,
        fillRatio: text ? pageFillRatio(text, options, pageIndex) : 0,
        manualBreakBefore: sectionIndex > 0 && sectionPageIndex === 0,
        sectionIndex,
        sourceOffset: sectionSourceOffset + offsetInSection,
      });
      searchOffset = offsetInSection + text.length;
    });

    sectionSourceOffset += section.length + (sectionIndex < sections.length - 1 ? PAGE_BREAK_MARKER.length : 0);
  });

  return pages.length ? pages : [{
    text: "",
    fillRatio: 0,
    manualBreakBefore: false,
    sectionIndex: 0,
    sourceOffset: 0,
  }];
}

export function setManualBreakBefore(source: string, page: PaginatedPage, enabled: boolean) {
  const normalized = source.replace(/\r\n?/g, "\n");
  if (enabled) {
    if (page.manualBreakBefore || page.sourceOffset <= 0) return normalized;
    const before = normalized.slice(0, page.sourceOffset).trimEnd();
    const after = normalized.slice(page.sourceOffset).trimStart();
    return `${before}\n\n${PAGE_BREAK_MARKER}\n\n${after}`;
  }

  if (!page.manualBreakBefore || page.sectionIndex <= 0) return normalized;
  const sections = normalized.split(PAGE_BREAK_MARKER);
  const previousIndex = page.sectionIndex - 1;
  if (page.sectionIndex >= sections.length) return normalized;
  sections.splice(
    previousIndex,
    2,
    `${sections[previousIndex].trimEnd()}\n\n${sections[page.sectionIndex].trimStart()}`,
  );
  return sections.join(`\n\n${PAGE_BREAK_MARKER}\n\n`);
}
