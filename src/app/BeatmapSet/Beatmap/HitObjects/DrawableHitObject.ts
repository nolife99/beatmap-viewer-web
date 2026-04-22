import { HitResult, type LegacyReplayFrame } from 'osu-classes';
import { StandardHitObject } from 'osu-standard-stable';
import { Container } from 'pixi.js';
import { BaseObjectEvaluation } from '../Replay.ts';
import DrawableApproachCircle from './DrawableApproachCircle.ts';
import SkinnableElement from './SkinnableElement.ts';

export interface IHasApproachCircle {
	approachCircle: DrawableApproachCircle;
}

export default abstract class DrawableHitObject extends SkinnableElement {
	abstract container: Container;
	abstract object: StandardHitObject;

	constructor(_: StandardHitObject) {
		super();
		this.context.provide('object', this);
	}

	_evaluation?: BaseObjectEvaluation;

	get evaluation(): BaseObjectEvaluation | undefined {
		return this._evaluation;
	}

	set evaluation(value: BaseObjectEvaluation | undefined) {
		this._evaluation = value;
	}

	abstract update(time: number): void;

	abstract getTimeRange(): { start: number; end: number };

	playHitSound(_?: number, __?: number) {
	}

	disable() {
		this.container.visible = false;
	}

	eval(_: LegacyReplayFrame[]) {
		return {
			value: HitResult.Great,
			hitTime: this.object.startTime
		};
	}

	abstract destroy(): void;
}
