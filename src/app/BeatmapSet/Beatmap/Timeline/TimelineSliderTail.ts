import { Slider, SliderEnd } from 'osu-standard-stable';
import Skin, { BLANK_TEXTURE } from '../../../Skinning/Skin.ts';
import DrawableSlider from '../HitObjects/DrawableSlider.ts';
import TimelineHitCircle from './TimelineHitCircle.ts';

export default class TimelineSliderTail extends TimelineHitCircle {
	protected actualTime: number;

	constructor(parent: Slider, object: SliderEnd) {
		super(object);

		this.container.removeChild(this.defaults.container);
		this.defaults.destroy();

		this.actualTime = parent.duration;
	}

	override get time() {
		return this.actualTime;
	}

	override refreshSprite() {
		const skin = this.skinManager?.getCurrentSkin();
		if (!skin) return;

		const hitCircle = skin.config.General.Argon
			? BLANK_TEXTURE
			: (skin.getTexture(
					'sliderendcircle',
					this.context.consume<Skin>('beatmapSkin')
				) ??
				skin.getTexture(
					'hitcircle',
					this.context.consume<Skin>('beatmapSkin')
				));
		const hitCircleOverlay = skin.config.General.Argon
			? BLANK_TEXTURE
			: skin.getTexture(
				'sliderendcircle',
				this.context.consume<Skin>('beatmapSkin')
			)
				? (skin.getTexture(
					'sliderendcircleoverlay',
					this.context.consume<Skin>('beatmapSkin')
				) ?? BLANK_TEXTURE)
				: skin.getTexture(
					'hitcircleoverlay',
					this.context.consume<Skin>('beatmapSkin')
				);
		const select = skin.getTexture(
			'hitcircleselect',
			this.context.consume<Skin>('beatmapSkin')
		);

		if (hitCircle) this.hitCircle.texture = hitCircle;
		if (hitCircleOverlay) this.hitCircleOverlay.texture = hitCircleOverlay;
		this.select.texture =
			(skin.config.General.Argon ? BLANK_TEXTURE : select) ?? BLANK_TEXTURE;

		this.hitCircle.tint = this.context.consume<DrawableSlider>('object')?.color ?? 'rgb(0,0,0)';
	}
}
