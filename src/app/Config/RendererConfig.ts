import type Config from '.';
import ConfigSection from './ConfigSection.ts';

export type RENDERER = "webgl" | "webgpu";
export type RendererProps = {
  renderer?: RENDERER;
  resolution?: number;
  antialiasing?: boolean;
};

enum RENDERER_VAL {
  "webgl" = "WebGL",
  "webgpu" = "WebGPU",
}

export default class RendererConfig extends ConfigSection {
  constructor(config: Config, defaultOptions?: RendererProps) {
    super(config);

    this.loadEventListeners();

    if (!defaultOptions) return;

    const { renderer, resolution, antialiasing } = defaultOptions;
    this.renderer = (renderer as string) === "WEBGL2"
      ? "webgl"
      : (renderer ?? "webgl");
    this.resolution = resolution ?? 1;
    this.antialiasing = antialiasing ?? false;
  }

  private _renderer: RENDERER = "webgl";
  get renderer() {
    return this._renderer;
  }

  set renderer(val: RENDERER) {
    this._renderer = val;

    const ele = document.querySelector<HTMLSpanElement>("#currentRenderer");
    if (!ele) return;
    ele.innerText = RENDERER_VAL[val];

    this.emitChange("renderer", val);
  }

  private _resolution = 1;
  get resolution() {
    return this._resolution;
  }

  set resolution(val: number) {
    this._resolution = val;
    this.emitChange("resolution", val);
  }

  private _antialiasing = false;
  get antialiasing() {
    return this._antialiasing;
  }

  set antialiasing(val: boolean) {
    const ele = document.querySelector<HTMLInputElement>("#antialiasing");
    if (!ele) return;
    ele.checked = val;

    if (this._antialiasing === val) return;
    this._antialiasing = val;
    this.emitChange("antialiasing", val);
  }

  override emitChange(key: keyof RendererProps, newValue: any) {
    return super.emitChange(key, newValue);
  }

  override onChange(
    key: keyof RendererProps,
    callback: (newValue: any) => void,
  ) {
    super.onChange(key, callback);
  }

  loadEventListeners() {
    document
      .querySelector<HTMLInputElement>("#antialiasing")
      ?.addEventListener("change", (event) => {
        const value = (event.target as HTMLInputElement)?.checked ?? true;
        this.antialiasing = value;
      });

    for (
      const ele of document.querySelectorAll<HTMLButtonElement>(
        ".renderer-select",
      )
    ) {
      ele.addEventListener("click", (event) => {
        const value =
          ((event.target as HTMLButtonElement)?.dataset.renderer as RENDERER) ??
            "webgl";
        this.renderer = value;
      });
    }
  }

  override jsonify(): RendererProps {
    return {
      renderer: this.renderer,
      resolution: this.resolution,
      antialiasing: this.antialiasing,
    };
  }
}
