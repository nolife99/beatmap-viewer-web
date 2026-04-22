import { SliderRepeat } from 'osu-standard-stable';
import { Graphics, GraphicsContext, Sprite } from 'pixi.js';
import Skin from '../../../Skinning/Skin.ts';
import TimelineSliderTail from './TimelineSliderTail.ts';

const ctx = new GraphicsContext().circle(0, 0, 15).fill([0, 0, 0, 0.3]);

export default class TimelineSliderRepeat extends TimelineSliderTail {
	sprite = new Sprite({
		anchor: 0.5
	});
	graphics = new Graphics({ context: ctx });

	constructor(object: SliderRepeat) {
		super(object);

		this.container.addChild(this.sprite, this.graphics);
		this.refreshSprite();
	}

	override refreshSprite() {
		if (!this.sprite || !this.graphics) return;
		super.refreshSprite();

		const skin = this.skinManager?.getCurrentSkin();
		if (!skin) return;

		const reverseArrow = skin.getTexture(
			'reversearrow',
			this.context.consume<Skin>('beatmapSkin')
		);

		if (reverseArrow && this.sprite) this.sprite.texture = reverseArrow;

		if (skin.config.General.Argon) {
			this.container.removeChild(this.sprite);
			if (!this.graphics) return;

			this.container.addChild(this.graphics);
		} else {
			if (this.graphics) this.container.removeChild(this.graphics);
			this.container.addChild(this.sprite);
		}
	}
}
