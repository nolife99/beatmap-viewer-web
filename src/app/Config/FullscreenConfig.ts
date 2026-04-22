import type Config from '.';
import ConfigSection from './ConfigSection.ts';

type FullscreenProps = {
  fullscreen: boolean;
};

export default class FullscreenConfig extends ConfigSection {
  constructor(config: Config, defaultOptions?: FullscreenProps) {
    super(config);

    if (!defaultOptions) return;

    const { fullscreen } = defaultOptions;
    this.fullscreen = fullscreen;
  }

  private _fullscreen = false;
  get fullscreen() {
    return this._fullscreen;
  }

  set fullscreen(val: boolean) {
    this._fullscreen = val;
    this.emitChange("fullscreen", val);
  }

  override jsonify() {
    return {};
  }
}
