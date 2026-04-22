import { Circle } from 'osu-standard-stable';
import { Color, Sprite } from 'pixi.js';
import { Context } from '../../../Context.ts';
import Skin, { BLANK_TEXTURE } from '../../../Skinning/Skin.ts';
import DrawableDefaults from '../HitObjects/DrawableDefaults.ts';
import DrawableHitCircle from '../HitObjects/DrawableHitCircle.ts';
import TimelineHitObject from './TimelineHitObject.ts';

export default class TimelineHitCircle extends TimelineHitObject {
	hitCircle: Sprite;
	hitCircleOverlay: Sprite;
	defaults: DrawableDefaults;
	select: Sprite;

	constructor(object: Circle) {
		super(object);

		this.defaults = new DrawableDefaults(object);

		this.hitCircle = new Sprite();
		this.hitCircleOverlay = new Sprite();
		this.select = new Sprite({ visible: false });

		this.hitCircle.anchor.set(0.5);
		this.hitCircleOverlay.anchor.set(0.5);
		this.select.anchor.set(0.5);

		this.container.scale.set(50 / 128);

		this.container.addChild(
			this.hitCircle,
			this.defaults.container,
			this.hitCircleOverlay,
			this.select
		);

		this.refreshSprite();
	}

	override get object() {
		return super.object as Circle;
	}

	override set object(val: Circle) {
		super.object = val;
		if (this.defaults) this.defaults.object = val;
	}

	override set isSelected(val: boolean) {
		super.isSelected = val;
		this.select.visible = val;
	}

	refreshSprite() {
		const skin = this.skinManager?.getCurrentSkin();
		if (!skin) return;

		const timelineHitCircle = skin.getTexture(
			'timelinehitcircle',
			this.context.consume<Skin>('beatmapSkin')
		);
		const hitCircle = skin.getTexture(
			'hitcircle',
			this.context.consume<Skin>('beatmapSkin')
		);
		const hitCircleOverlay = skin.getTexture(
			'hitcircleoverlay',
			this.context.consume<Skin>('beatmapSkin')
		);
		const select = skin.getTexture(
			'hitcircleselect',
			this.context.consume<Skin>('beatmapSkin')
		);

		this.hitCircle.texture =
			(skin.config.General.Argon
				? (timelineHitCircle ?? hitCircle)
				: hitCircle) ?? BLANK_TEXTURE;
		this.hitCircleOverlay.texture =
			(skin.config.General.Argon ? BLANK_TEXTURE : hitCircleOverlay) ??
			BLANK_TEXTURE;
		this.select.texture = select ?? BLANK_TEXTURE;
		this.select.scale.set(skin.config.General.Argon ? 256 / 236 : 1);

		const color =
			this.context.consume<DrawableHitCircle>('object')?.color ?? 'rgb(0,0,0)';
		this.hitCircle.tint = color;
		this.defaults.container.tint = 0xffffff;
		this.defaults.container.children.map((sprite) => {
			sprite.tint = 0xffffff;
		});

		if (!skin.config.General.Argon) return;

		const col = new Color(color);
		if (!col) return;

		const lumi =
			0.299 * col.red +
			0.587 * col.green +
			0.114 * col.blue;
		this.defaults.container.tint = lumi > 0.5 ? color : 0xffffff;
		this.defaults.container.children.map(sprite => {
			sprite.tint = lumi > 0.5 ? 0x333333 : 0xe5e5e5;
		});
	}

	override hook(context: Context) {
		super.hook(context);

		this.refreshSprite();

		return this;
	}

	getTimeRange(): { start: number; end: number } {
		return {
			start: this.object.startTime - 30 * 5,
			end: this.object.startTime + 30 * 5
		};
	}
}
