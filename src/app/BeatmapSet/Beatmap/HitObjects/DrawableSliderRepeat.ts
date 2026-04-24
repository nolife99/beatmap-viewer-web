import { HitSample as Sample } from 'osu-classes';
import { Slider, SliderHead, SliderRepeat, StandardHitObject } from 'osu-standard-stable';
import { Container, Sprite } from 'pixi.js';
import { update as argonUpdate } from '../../../Skinning/Argon/ArgonReverseArrow.ts';
import { update as legacyUpdate } from '../../../Skinning/Legacy/LegacyReverseArrow.ts';
import Skin, { BLANK_TEXTURE } from '../../../Skinning/Skin.ts';
import DrawableSliderTail from './DrawableSliderTail.ts';

export default class DrawableSliderRepeat extends DrawableSliderTail {
	reverseArrow = new Sprite({
		anchor: 0.5
	});

	ringPiece = new Sprite({
		anchor: 0.5
	});

	rotation!: number;

	arrowContainer = new Container();
	arrowUpdateFn = legacyUpdate;

	constructor(
		object: SliderRepeat,
		public override parent: Slider,
		samples: Sample[]
	) {
		super(object, parent, samples);

		this.arrowContainer.interactive = false;
		this.arrowContainer.interactiveChildren = false;

		this.arrowContainer.addChild(this.reverseArrow, this.ringPiece);

		this.container.addChild(this.arrowContainer);
		this.refreshSprite();
		this.updateRotation();
	}

	override get object(): SliderRepeat {
		return super.object as SliderRepeat;
	}

	override set object(val: StandardHitObject) {
		super.object = val;
	}

	override updateObjects(
		object: SliderHead,
		parent: Slider,
		samples: Sample[]
	): void {
		super.updateObjects(object, parent, samples);
		this.parent = parent;
		this.updateRotation();
	}

	override refreshSprite(): void {
		super.refreshSprite();

		if (!this.reverseArrow) return;

		const skin = this.skinManager?.getCurrentSkin();
		if (!skin) return;

		this.arrowUpdateFn = skin?.config.General.Argon
			? argonUpdate
			: legacyUpdate;

		const reverseArrow = skin.getTexture(
			'reversearrow',
			this.context.consume<Skin>('beatmapSkin')
		);
		if (reverseArrow) this.reverseArrow.texture = reverseArrow;

		const ringPiece = skin.getTexture(
			'repeat-edge-piece',
			this.context.consume<Skin>('beatmapSkin')
		);
		this.ringPiece.texture = skin?.config.General.Argon
			? (ringPiece ?? BLANK_TEXTURE)
			: BLANK_TEXTURE;
	}

	updateRotation() {
		const isAtEnd = (this.object as SliderRepeat).repeatIndex % 2 === 0;

		const first = isAtEnd ? this.parent.path.calculatedPath.length - 1 : 0;
		let next = first;

		while (
			this.parent.path.calculatedPath[first].distance(
				this.parent.path.calculatedPath[next]
			) < 0.01
			) {
			if (isAtEnd) {
				next--;
				continue;
			}

			next++;
		}

		const startVec = this.parent.path.calculatedPath[first];
		const endVec = this.parent.path.calculatedPath[next];

		const rotation = Math.atan2(endVec.y - startVec.y, endVec.x - startVec.x);
		this.rotation = rotation;
		this.arrowContainer.rotation = rotation;
	}

	override update(time: number) {
		super.update(time);
		this.arrowUpdateFn(this, time);
	}
}
