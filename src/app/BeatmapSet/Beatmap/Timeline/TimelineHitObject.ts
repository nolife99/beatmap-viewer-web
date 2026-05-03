import { StandardHitObject } from 'osu-standard-stable';
import { Container } from 'pixi.js';
import TimelineConfig from '../../../Config/TimelineConfig.ts';
import { inject } from '../../../Context.ts';
import { DEFAULT_SCALE } from '../../../UI/main/viewer/Timeline/index.ts';
import SkinnableElement from '../HitObjects/SkinnableElement.ts';

export default abstract class TimelineHitObject extends SkinnableElement {
	container: Container = new Container({
		visible: false
	});
	abstract select: Container;

	constructor(object: StandardHitObject) {
		super();
		this.object = object;
		this.container.y = 40;

		this.container.onRender = () => {
			const scale = inject<TimelineConfig>('config/timeline')?.scale ?? 1;
			this.container.x = this.object.startTime / (DEFAULT_SCALE / scale);
		}
	}

	protected _object!: StandardHitObject;
	get object() {
		return this._object;
	}

	set object(val: StandardHitObject) {
		this._object = val;
	}

	protected _isSelected = false;
	get isSelected() {
		return this._isSelected;
	}

	set isSelected(val: boolean) {
		this._isSelected = val;
	}

	abstract getTimeRange(): { start: number; end: number };

	abstract refreshSprite(): void;

	override destroy() {
		this.container.destroy();
		super.destroy();
	}
}
