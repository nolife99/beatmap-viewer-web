import { HitResult, type LegacyReplayFrame } from 'osu-classes';
import { Slider, Spinner } from 'osu-standard-stable';
import Beatmap from '..';
import { inject } from '../../../Context.ts';
import { BLANK_TEXTURE } from '../../../Skinning/Skin.ts';
import ProgressBar from '../../../UI/main/controls/ProgressBar.ts';
import { Clamp } from '../../../utils.ts';
import BeatmapSet from '../../index.ts';
import TimelineHitCircle from '../Timeline/TimelineHitCircle.ts';
import TimelineSlider from '../Timeline/TimelineSlider.ts';
import DrawableHitCircle from './DrawableHitCircle.ts';
import { TAIL_LENIENCY } from './DrawableSliderTail.ts';
import DrawableSpinnerApproachCircle from './DrawableSpinnerApproachCircle.ts';

export default class DrawableSpinner extends DrawableHitCircle {
	constructor(object: Spinner) {
		super(object, false);
		this.approachCircle.destroy();

		this.wrapper.visible = true;
		this.approachCircle.container.visible = true;

		this.approachCircle = new DrawableSpinnerApproachCircle(object).hook(
			this.context
		);

		this.timelineObject?.destroy();

		const cloned = object.clone();
		const head = object.clone();
		const tail = object.clone();
		head.startTime = head.startTime - TAIL_LENIENCY;
		tail.startTime = tail.endTime - TAIL_LENIENCY;
		cloned.nestedHitObjects = [head, tail];
		this.timelineObject = new TimelineSlider(cloned as unknown as Slider).hook(
			this.context
		) as unknown as TimelineHitCircle;
	}

	override getTimeRange(): { start: number; end: number } {
		return {
			start: this.object.startTime - this.object.timePreempt,
			end: (this.object as Spinner).endTime + 800
		};
	}

	override refreshSprite(): void {
		super.refreshSprite();

		this.hitCircleOverlay.texture =
			this.skinManager?.getCurrentSkin().getTexture('spinner-bottom') ??
			BLANK_TEXTURE;
		this.hitCircleSprite.texture = BLANK_TEXTURE;
		this.flashPiece.texture = BLANK_TEXTURE;
		this.select.texture = BLANK_TEXTURE;
		this.container.tint = 0xffffff;
	}

	override update(time: number) {
		this.approachCircle.update(time);
		this.judgement.frame(time);

		const startFadeInTime = this.object.startTime - this.object.timePreempt;
		const fadeOutDuration = 800;
		const endTime = (this.object as Spinner).endTime;

		if (time < startFadeInTime || time > endTime + fadeOutDuration) {
			this.wrapper.visible = false;
			return;
		}

		this.wrapper.visible = true;

		if (time < this.object.startTime) {
			const opacity = Clamp((time - startFadeInTime) / this.object.timeFadeIn);
			this.wrapper.alpha = opacity;

			return;
		}

		if (time >= this.object.startTime) {
			const opacity = 1 - Clamp((time - endTime) / fadeOutDuration);
			this.wrapper.alpha = opacity;

			return;
		}

		this.wrapper.alpha = 1;
	}

	override playHitSound(time: number, _?: number): void {
		const beatmap = this.context.consume<Beatmap>('beatmapObject');
		const endTime = (this.object as Spinner).endTime;
		const isSeeking =
			inject<ProgressBar>('ui/main/controls/progress')?.isSeeking ||
			inject<BeatmapSet>('beatmapset')?.isSeeking;
		if (!beatmap || isSeeking) return;
		if (
			!(
				beatmap.previousTime <= endTime &&
				endTime < time &&
				time - beatmap.previousTime < 30
			)
		)
			return;

		const currentSamplePoint = beatmap.getNearestSamplePoint(endTime);
		this.hitSound?.play(currentSamplePoint);
	}

	override eval(_: LegacyReplayFrame[]) {
		return {
			value: HitResult.Great,
			hitTime: (this.object as Spinner).endTime
		};
	}
}