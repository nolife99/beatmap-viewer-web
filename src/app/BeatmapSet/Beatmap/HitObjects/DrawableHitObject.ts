import type { StandardHitObject } from 'osu-standard-stable';
import type { Container } from 'pixi.js';
import type DrawableApproachCircle from './DrawableApproachCircle.ts';
import SkinnableElement from './SkinnableElement.ts';
import { HitResult, type LegacyReplayFrame } from 'osu-classes';
import type { BaseObjectEvaluation } from '../Replay.ts';

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
