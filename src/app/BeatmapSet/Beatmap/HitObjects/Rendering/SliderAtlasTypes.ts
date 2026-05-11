import type { Color, ColorSource, Rectangle, Sprite, Texture } from 'pixi.js';
import type SliderProgressView from './CalculateSliderProgress.ts';
import type SliderAtlasPage from './SliderAtlasPage.ts';

export type SliderUniformPatch = Partial<{
	borderColor: ColorSource;
	innerColor: ColorSource;
	outerColor: ColorSource;
	borderWidth: number;
	bodyAlpha: number;
	scale: number;
	uRadius: number;
}>;

export type SliderInstanceStyle = {
	borderColor: Color;
	innerColor: Color;
	outerColor: Color;
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

export type FrameMetrics = {
	viewport: Rectangle;
	viewportRight: number;
	viewportBottom: number;
	resolution: number;
};

export type PackablePayload = {
	handle: SliderBodyHandle;
	target: SliderVisualTarget;
	renderRect: Rectangle;
	renderScaleX: number;
	renderScaleY: number;
	physicalWidth: number;
	physicalHeight: number;
};

export type SliderVisualTarget = {
	sprite: Sprite;
	texture?: Texture;
	frame: Rectangle;
	renderRect: Rectangle;
	path?: SliderProgressView;
	radius: number;
	style: SliderInstanceStyle;
	placedFrame: number;

	/** Geometry/data availability. Set once update*Geometry supplies a path. */
	enabled: boolean;

	/** External visibility gate. Body and selection are controlled independently. */
	visible: boolean;
};

export type SliderBodyHandle = {
	alive: boolean;
	x: number;
	y: number;
	body: SliderVisualTarget;
	selection: SliderVisualTarget;
};
