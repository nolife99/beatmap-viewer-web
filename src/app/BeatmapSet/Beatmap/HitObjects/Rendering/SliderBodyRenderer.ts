import { Sprite, Texture } from 'pixi.js';
import type SliderProgressView from './CalculateSliderProgress.ts';
import BeatmapSliderLayer from './BeatmapSliderLayer.ts';
import type { SliderBodyHandle, SliderUniformPatch } from './SliderAtlasTypes.ts';

function createSliderSprite(): Sprite {
	const sprite = new Sprite(Texture.EMPTY);
	sprite.anchor.set(0, 0);
	sprite.visible = false;
	sprite.blendMode = 'normal';
	return sprite;
}

export default class SliderBodyRenderer {
	public readonly body = createSliderSprite();
	public readonly selectionBody = createSliderSprite();

	private readonly layer: BeatmapSliderLayer;
	private readonly handle: SliderBodyHandle;
	private destroyed = false;

	constructor(layer: BeatmapSliderLayer) {
		this.layer = layer;
		this.handle = layer.createSlider(this.body, this.selectionBody);
	}

	setPosition(x: number, y: number) {
		if (this.destroyed) return;
		this.layer.setPosition(this.handle, x, y);
	}

	setUniforms(patch: SliderUniformPatch, includeSelection = true) {
		this.setBodyUniforms(patch);
		if (includeSelection) this.setSelectionUniforms(patch);
	}

	setBodyUniforms(patch: SliderUniformPatch) {
		if (this.destroyed) return;
		this.layer.setBodyStyle(this.handle, patch);
	}

	setSelectionUniforms(patch: SliderUniformPatch) {
		if (this.destroyed) return;
		this.layer.setSelectionStyle(this.handle, patch);
	}

	updateMainGeometry(path: SliderProgressView, radius: number) {
		if (this.destroyed) return;
		this.layer.setBodyGeometrySource(this.handle, path, radius);
	}

	updateSelectionGeometry(path: SliderProgressView, radius: number) {
		if (this.destroyed) return;
		this.layer.setSelectionGeometrySource(this.handle, path, radius);
	}

	setBodyVisible(visible: boolean) {
		if (this.destroyed) return;
		this.layer.setBodyVisible(this.handle, visible);
	}

	setSelectionVisible(visible: boolean) {
		if (this.destroyed) return;
		this.layer.setSelectionVisible(this.handle, visible);
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;

		this.layer.deleteSlider(this.handle);
		this.body.destroy(true);
		this.selectionBody.destroy(true);
	}
}
