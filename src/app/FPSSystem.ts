import { type BitmapText, ExtensionType, extensions, type Renderer, Ticker } from "pixi.js";
import { inject } from "./Context";
import { Game } from "./Game";

export class FPSSystem {
	static extension = {
		type: [ExtensionType.WebGLSystem, ExtensionType.WebGPUSystem],
		name: "fps",
	};

	_renderer;

	constructor(renderer: Renderer) {
		this._renderer = renderer;
	}

	init() {
		this._renderer.runners.prerender.add(this);
		this._renderer.runners.postrender.add(this);
	}

	destroy() {
		this._renderer.runners.prerender.remove(this);
		this._renderer.runners.postrender.remove(this);
	}

	prerender() {
		performance.mark("0");
	}

	postrender() {
		performance.measure("", "0");
		performance.clearMarks();

		const entries = performance.getEntriesByType("measure");
		const entryCount = entries.length;

		entries.splice(0, entries.length - 30);

		const avgDeltaMS =
			entries.reduce((accm, curr, idx) => {
				return accm + curr.duration * ((idx + 1) / entries.length);
			}, 0) /
			((1 / entries.length + 1) * (entries.length / 2));

		inject<Game>("game")?.update();

		const fps = inject<BitmapText>("ui/main/viewer/gameplays/fps");
		if (fps) fps.text = `${Ticker.shared.FPS.toFixed()} fps`;

		const frameTime = inject<BitmapText>("ui/main/viewer/gameplays/frametime");
		if (frameTime) frameTime.text = `${avgDeltaMS.toFixed(2)} ms`;

		if (entryCount >= 128) performance.clearMeasures();
	}
}

extensions.add(FPSSystem);
