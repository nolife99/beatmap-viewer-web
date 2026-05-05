import type { Sprite } from 'pixi.js';
import type SliderProgressView from './CalculateSliderProgress.ts';
import BeatmapSliderLayer from './BeatmapSliderLayer.ts';
import type { SliderUniformPatch } from './SliderAtlasTypes.ts';

export default class SliderBodyRenderer {
	public readonly body: Sprite;
	public readonly selectionBody: Sprite;

	private readonly layer: BeatmapSliderLayer;
	private readonly id: number;
	private destroyed = false;

	constructor(layer: BeatmapSliderLayer) {
		this.layer = layer;
		this.id = layer.createSlider();

		const entry = layer.getEntry(this.id);
		this.body = entry.body.sprite;
		this.selectionBody = entry.selection.sprite;
	}

	setPosition(x: number, y: number) {
		if (this.destroyed) return;
		this.layer.setPosition(this.id, x, y);
	}

	setUniforms(patch: SliderUniformPatch, includeSelection = true) {
		this.setBodyUniforms(patch);
		if (includeSelection) this.setSelectionUniforms(patch);
	}

	setBodyUniforms(patch: SliderUniformPatch) {
		if (this.destroyed) return;
		this.layer.setBodyStyle(this.id, patch);
	}

	setSelectionUniforms(patch: SliderUniformPatch) {
		if (this.destroyed) return;
		this.layer.setSelectionStyle(this.id, patch);
	}

	updateMainGeometry(path: SliderProgressView, radius: number) {
		if (this.destroyed) return;
		this.layer.setBodyGeometrySource(this.id, path, radius);
	}

	updateSelectionGeometry(path: SliderProgressView, radius: number) {
		if (this.destroyed) return;
		this.layer.setSelectionGeometrySource(this.id, path, radius);
	}

	setBodyVisible(visible: boolean) {
		if (this.destroyed) return;
		this.layer.setBodyVisible(this.id, visible);
	}

	setSelectionVisible(visible: boolean) {
		if (this.destroyed) return;
		this.layer.setSelectionVisible(this.id, visible);
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.layer.deleteSlider(this.id);
	}
}
