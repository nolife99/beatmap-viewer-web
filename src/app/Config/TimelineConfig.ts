import { FederatedWheelEvent } from 'pixi.js';
import Config from '.';
import { Clamp } from '../utils.ts';
import ConfigSection from './ConfigSection.ts';

type TimelineConfigEvents = 'scale' | 'divisor';

export type TimelineProps = {
	scale?: number;
	divisor?: number;
};

export default class TimelineConfig extends ConfigSection {
	constructor(config: Config, defaultOptions?: TimelineProps) {
		super(config);
		if (!defaultOptions) return;

		const { scale, divisor } = defaultOptions;
		this.scale = Clamp(scale ?? 1, 0.5, 1.5);
		this.divisor = divisor ?? 4;
	}

	private _scale = 1.0;
	get scale() {
		return this._scale;
	}

	set scale(val: number) {
		this._scale = Clamp(val, 0.5, 1.5);
		this.emitChange('scale', val);
	}

	private _divisor = 4;
	get divisor() {
		return this._divisor;
	}

	set divisor(val: number) {
		this._divisor = val;
		this.emitChange('divisor', val);
	}

	override onChange(
		key: TimelineConfigEvents,
		callback: (newValue: any) => void
	): void {
		super.onChange(key, callback);
	}

	handleWheel(event: FederatedWheelEvent) {
		if (event.deltaY < 0) {
			this.divisor = Math.min(
				16,
				this.divisor === 9 ? 12 : this.divisor === 12 ? 16 : this.divisor + 1
			);
		}

		if (event.deltaY > 0) {
			this.divisor = Math.max(
				1,
				this.divisor === 16 ? 12 : this.divisor === 12 ? 9 : this.divisor - 1
			);
		}
	}

	override jsonify(): TimelineProps {
		return {
			scale: this.scale,
			divisor: this.divisor
		};
	}
}
