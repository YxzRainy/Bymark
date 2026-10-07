import { defineComponent } from "vue";
import { Minus, Plus } from "lucide-vue-next";
import type { BymarkState } from "../bymark";
import { SCENE_CARD_HEIGHT_MAX, SCENE_CARD_HEIGHT_MIN, SCENE_CARD_PADDING_MAX, SCENE_CARD_PADDING_MIN } from "../bymark";
import { SCENE_BACKDROPS } from "../sceneBackdrops";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { UploadField } from "./UploadField";

export const BackdropControls = defineComponent(
  (props: {
    state: BymarkState;
    update: <K extends keyof BymarkState>(key: K, value: BymarkState[K]) => void;
    sceneImage: string | null;
    onSceneImageFile: (file: File) => void;
    onRemoveSceneImage: () => void;
    showCardGeometry?: boolean;
    settingsLabel?: string;
    idPrefix?: string;
  }) => {
    const idFor = (name: string) => `${props.idPrefix ?? "bymark"}-${name}`;
    const selectBackdrop = (id: BymarkState["sceneBackdrop"]) => {
      props.update("sceneBackdrop", id);
      if (props.sceneImage) props.onRemoveSceneImage();
    };
    return () => (
      <div class="scene-controls">
        <label class="field-label">背景</label>
        <div class="scene-background-row">
          <UploadField
            value={props.sceneImage}
            kind="scene"
            onFile={props.onSceneImageFile}
            onRemove={props.onRemoveSceneImage}
          />
          <div class="scene-backdrop-picker" role="radiogroup" aria-label="内置渐变背景">
            {SCENE_BACKDROPS.map((backdrop) => {
              const active = !props.sceneImage && props.state.sceneBackdrop === backdrop.id;
              return (
                <button
                  key={backdrop.id}
                  type="button"
                  role="radio"
                  class={["scene-backdrop-swatch", active && "active"]}
                  aria-checked={active}
                  aria-label={backdrop.label}
                  title={backdrop.label}
                  style={{ background: backdrop.gradient }}
                  onClick={() => selectBackdrop(backdrop.id)}
                />
              );
            })}
          </div>
        </div>
        <SettingsDisclosure
          id={idFor("scene-details")}
          label={props.settingsLabel ?? "场景微调"}
          summary={`${props.showCardGeometry ? `${props.state.sceneCardRatio} · 卡片 ${props.state.sceneCardScale}% · 高度 ${props.state.sceneCardHeight}% · 内边距 ${props.state.sceneCardPadding}% · ` : ""}遮罩 ${props.state.sceneOverlay}%`}
          class="scene-settings-disclosure"
        >
          {props.showCardGeometry && (
            <>
              <label class="field-label">卡片比例</label>
              <div class="theme-picker scene-segmented" role="group" aria-label="文字卡片比例">
                {(["3:4", "1:1", "4:3"] as const).map((ratio) => (
                  <button
                    key={ratio}
                    type="button"
                    class={props.state.sceneCardRatio === ratio ? "active" : ""}
                    onClick={() => props.update("sceneCardRatio", ratio)}
                  >
                    {ratio}
                  </button>
                ))}
              </div>
              <div class="range-label">
                <label class="field-label" for={idFor("scene-card-scale")}>卡片大小</label>
                <output for={idFor("scene-card-scale")}>{props.state.sceneCardScale}%</output>
              </div>
              <div
                class="font-scale-control scene-card-scale-control"
                style={{ "--font-progress": `${((props.state.sceneCardScale - 70) / 30) * 100}%` } as Record<string, string>}
              >
                <button
                  type="button"
                  class="scale-step"
                  aria-label="卡片缩小 1%"
                  title="卡片缩小 1%"
                  disabled={props.state.sceneCardScale <= 70}
                  onClick={() => props.update("sceneCardScale", Math.max(70, props.state.sceneCardScale - 1))}
                ><Minus size={14} aria-hidden="true" /></button>
                <input
                  id={idFor("scene-card-scale")}
                  type="range"
                  min="70"
                  max="100"
                  step="1"
                  value={props.state.sceneCardScale}
                  onInput={(event) => props.update("sceneCardScale", Number((event.target as HTMLInputElement).value))}
                />
                <button
                  type="button"
                  class="scale-step"
                  aria-label="卡片放大 1%"
                  title="卡片放大 1%"
                  disabled={props.state.sceneCardScale >= 100}
                  onClick={() => props.update("sceneCardScale", Math.min(100, props.state.sceneCardScale + 1))}
                ><Plus size={14} aria-hidden="true" /></button>
              </div>
              <div class="range-label">
                <label class="field-label" for={idFor("scene-card-height")}>卡片高度</label>
                <output for={idFor("scene-card-height")}>{props.state.sceneCardHeight}%</output>
              </div>
              <div
                class="font-scale-control scene-card-height-control"
                style={{
                  "--font-progress": `${((props.state.sceneCardHeight - SCENE_CARD_HEIGHT_MIN) / (SCENE_CARD_HEIGHT_MAX - SCENE_CARD_HEIGHT_MIN)) * 100}%`,
                } as Record<string, string>}
              >
                <button
                  type="button"
                  class="scale-step"
                  aria-label="卡片高度减少 1%"
                  title="卡片高度减少 1%"
                  disabled={props.state.sceneCardHeight <= SCENE_CARD_HEIGHT_MIN}
                  onClick={() => props.update("sceneCardHeight", Math.max(SCENE_CARD_HEIGHT_MIN, props.state.sceneCardHeight - 1))}
                ><Minus size={14} aria-hidden="true" /></button>
                <input
                  id={idFor("scene-card-height")}
                  type="range"
                  min={SCENE_CARD_HEIGHT_MIN}
                  max={SCENE_CARD_HEIGHT_MAX}
                  step="1"
                  value={props.state.sceneCardHeight}
                  aria-valuetext={`${props.state.sceneCardHeight}%`}
                  onInput={(event) => props.update("sceneCardHeight", Number((event.target as HTMLInputElement).value))}
                />
                <button
                  type="button"
                  class="scale-step"
                  aria-label="卡片高度增加 1%"
                  title="卡片高度增加 1%"
                  disabled={props.state.sceneCardHeight >= SCENE_CARD_HEIGHT_MAX}
                  onClick={() => props.update("sceneCardHeight", Math.min(SCENE_CARD_HEIGHT_MAX, props.state.sceneCardHeight + 1))}
                ><Plus size={14} aria-hidden="true" /></button>
              </div>
              <div class="range-label">
                <label class="field-label" for={idFor("scene-card-padding")}>卡片内边距</label>
                <output for={idFor("scene-card-padding")}>{props.state.sceneCardPadding}%</output>
              </div>
              <div
                class="font-scale-control scene-card-padding-control"
                style={{
                  "--font-progress": `${((props.state.sceneCardPadding - SCENE_CARD_PADDING_MIN) / (SCENE_CARD_PADDING_MAX - SCENE_CARD_PADDING_MIN)) * 100}%`,
                } as Record<string, string>}
              >
                <button
                  type="button"
                  class="scale-step"
                  aria-label="卡片内边距减少 1%"
                  title="卡片内边距减少 1%"
                  disabled={props.state.sceneCardPadding <= SCENE_CARD_PADDING_MIN}
                  onClick={() => props.update("sceneCardPadding", Math.max(SCENE_CARD_PADDING_MIN, props.state.sceneCardPadding - 1))}
                ><Minus size={14} aria-hidden="true" /></button>
                <input
                  id={idFor("scene-card-padding")}
                  type="range"
                  min={SCENE_CARD_PADDING_MIN}
                  max={SCENE_CARD_PADDING_MAX}
                  step="1"
                  value={props.state.sceneCardPadding}
                  aria-valuetext={`${props.state.sceneCardPadding}%`}
                  onInput={(event) => props.update("sceneCardPadding", Number((event.target as HTMLInputElement).value))}
                />
                <button
                  type="button"
                  class="scale-step"
                  aria-label="卡片内边距增加 1%"
                  title="卡片内边距增加 1%"
                  disabled={props.state.sceneCardPadding >= SCENE_CARD_PADDING_MAX}
                  onClick={() => props.update("sceneCardPadding", Math.min(SCENE_CARD_PADDING_MAX, props.state.sceneCardPadding + 1))}
                ><Plus size={14} aria-hidden="true" /></button>
              </div>
            </>
          )}
          <div class="range-label">
            <label class="field-label" for={idFor("scene-overlay")}>背景遮罩</label>
            <output for={idFor("scene-overlay")}>{props.state.sceneOverlay}%</output>
          </div>
          <div
            class="font-scale-control scene-overlay-control"
            style={{ "--font-progress": `${(props.state.sceneOverlay / 70) * 100}%` } as Record<string, string>}
          >
            <button
              type="button"
              class="scale-step"
              aria-label="背景遮罩减少 1%"
              title="背景遮罩减少 1%"
              disabled={props.state.sceneOverlay <= 0}
              onClick={() => props.update("sceneOverlay", Math.max(0, props.state.sceneOverlay - 1))}
            ><Minus size={14} aria-hidden="true" /></button>
            <input
              id={idFor("scene-overlay")}
              type="range"
              min="0"
              max="70"
              step="1"
              value={props.state.sceneOverlay}
              onInput={(event) => props.update("sceneOverlay", Number((event.target as HTMLInputElement).value))}
            />
            <button
              type="button"
              class="scale-step"
              aria-label="背景遮罩增加 1%"
              title="背景遮罩增加 1%"
              disabled={props.state.sceneOverlay >= 70}
              onClick={() => props.update("sceneOverlay", Math.min(70, props.state.sceneOverlay + 1))}
            ><Plus size={14} aria-hidden="true" /></button>
          </div>
        </SettingsDisclosure>
      </div>
    );
  },
  {
    props: ["state", "update", "sceneImage", "onSceneImageFile", "onRemoveSceneImage", "showCardGeometry", "settingsLabel", "idPrefix"],
  },
);
