import { HitResult, type HitSample as Sample, type LegacyReplayFrame, Vector2 } from 'osu-classes';
import { Slider, SliderEnd } from 'osu-standard-stable';
import Beatmap from '..';
import HitSample from '../../../Audio/HitSample.ts';
import { inject } from '../../../Context.ts';
import { update } from '../../../Skinning/Argon/ArgonSliderTail.ts';
import Skin, { BLANK_TEXTURE } from '../../../Skinning/Skin.ts';
import ProgressBar from '../../../UI/main/controls/ProgressBar.ts';
import { Clamp } from '../../../utils.ts';
import BeatmapSet from '../../index.ts';
import DrawableSliderHead from './DrawableSliderHead.ts';

export const TAIL_LENIENCY = 36;

export default class DrawableSliderTail extends DrawableSliderHead {
	override hitSound?: HitSample;
	tailUpdateFn: null | typeof update = null;
	protected actualStartTime: number;

	constructor(
		object: SliderEnd,
		public override parent: Slider,
		samples: Sample[]
	) {
		super(object, parent, samples, false);

		this.hitSound = new HitSample(samples).hook(this.context);
		this.refreshSprite();

		this.actualStartTime = this.parent.startTime + this.parent.spanDuration * (object.repeatIndex + 1);
	}

	override refreshSprite() {
		super.refreshSprite();
		this.flashPiece.texture = BLANK_TEXTURE;

		const skin = this.skinManager?.getCurrentSkin();
		if (!skin) return;

		if (skin.config.General.Argon) {
			this.tailUpdateFn = update;
		} else {
			this.tailUpdateFn = null;
		}

		const hitCircle = skin.getTexture(
				'sliderendcircle',
				!skin.config.General.Argon
					? this.context.consume<Skin>('beatmapSkin')
					: undefined
			) ??
			skin.getTexture(
				'hitcircle',
				!skin.config.General.Argon
					? this.context.consume<Skin>('beatmapSkin')
					: undefined
			);
		const hitCircleOverlay = skin.getTexture(
			'sliderendcircle',
			!skin.config.General.Argon
				? this.context.consume<Skin>('beatmapSkin')
				: undefined
		)
			? (skin.getTexture(
				'sliderendcircleoverlay',
				!skin.config.General.Argon
					? this.context.consume<Skin>('beatmapSkin')
					: undefined
			) ?? BLANK_TEXTURE)
			: skin.getTexture(
				'hitcircleoverlay',
				!skin.config.General.Argon
					? this.context.consume<Skin>('beatmapSkin')
					: undefined
			);

		if (hitCircle) this.hitCircleSprite.texture = hitCircle;
		if (hitCircleOverlay) this.hitCircleOverlay.texture = hitCircleOverlay;
	}

	override playHitSound(time: number, offset: number): void {
		const beatmap = this.context.consume<Beatmap>('beatmapObject');
		const isSeeking =
			inject<ProgressBar>('ui/main/controls/progress')?.isSeeking ||
			inject<BeatmapSet>('beatmapset')?.isSeeking;
		if (!beatmap || isSeeking) return;
		if (
			!(
				beatmap.previousTime <= this.actualStartTime + offset &&
				this.actualStartTime + offset < time &&
				time - beatmap.previousTime < 30
			)
		) {
			return;
		}

		const currentSamplePoint = beatmap.getNearestSamplePoint(
			this.actualStartTime + offset
		);

		this.hitSound?.play(currentSamplePoint);
	}

	override eval(frames: LegacyReplayFrame[]) {
		const frame = frames.findLast(
			(frames) => frames.startTime <= this.actualStartTime
		);

		if (!frame || !(frame.mouseLeft || frame.mouseRight)) {
			return {
				value: HitResult.LargeTickMiss,
				hitTime: Infinity
			};
		}

		const completionProgress = Clamp(
			(this.actualStartTime - this.parent.startTime) / this.parent.duration
		);

		const position = this.parent.path.curvePositionAt(
			completionProgress,
			this.parent.spans
		);

		const x = frame.position.x;
		const y = frame.position.y;
		const pointer = new Vector2(x, y);

		const radius = 64 * this.object.scale * 2.4;
		const dist = pointer.distance(
			position.add(this.parent.stackedOffset).add(this.parent.startPosition)
		);

		if (dist > radius) {
			return {
				value: HitResult.LargeTickMiss,
				hitTime: Infinity
			};
		}

		return {
			value: HitResult.LargeTickHit,
			hitTime: this.actualStartTime
		};
	}

	override update(time: number): void {
		super.update(time);
		this.tailUpdateFn?.(this, time);
	}
}
