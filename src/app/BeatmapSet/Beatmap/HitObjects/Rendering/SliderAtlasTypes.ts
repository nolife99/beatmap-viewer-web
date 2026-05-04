import type { ColorSource, Rectangle, Sprite, Texture } from 'pixi.js';
import type { SliderProgressSource, SliderPathBounds } from './CalculateSliderProgress.ts';
import SliderAtlasPage from "./SliderAtlasPage.ts";

export type SliderUniformPatch = Partial<{
	borderColor: ColorSource;
	innerColor: ColorSource;
	outerColor: ColorSource;
	borderWidth: number;
	bodyAlpha: number;
	scale: number;
	uRadius: number;
}>;

export type SliderBounds = SliderPathBounds;

export type MutableBounds = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type SliderInstanceStyle = {
	borderR: number;
	borderG: number;
	borderB: number;
	borderA: number;

	innerR: number;
	innerG: number;
	innerB: number;
	innerA: number;

	outerR: number;
	outerG: number;
	outerB: number;
	outerA: number;

	borderWidth: number;
	bodyAlpha: number;
};

export type AtlasSlot = {
	page: SliderAtlasPage;
	x: number;
	y: number;
	width: number;
	height: number;
	scaleX: number;
	scaleY: number;
};

export type SliderVisualTarget = {
	sprite: Sprite;
	texture?: Texture;
	frame: Rectangle;
	path?: SliderProgressSource;
	radius: number;
	style: SliderInstanceStyle;
	renderBounds: MutableBounds;

	/** Geometry/data availability. This is set once update*Geometry supplies a path. */
	enabled: boolean;

	/** External visibility gate. Body and selection are controlled independently. */
	visible: boolean;
};

export type SliderEntry = {
	alive: boolean;
	x: number;
	y: number;
	maxLocalBounds: MutableBounds;
	body: SliderVisualTarget;
	selection: SliderVisualTarget;
};
