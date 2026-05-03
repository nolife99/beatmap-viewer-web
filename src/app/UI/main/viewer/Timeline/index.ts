import { TimingPoint } from 'osu-classes';
import { Slider } from 'osu-standard-stable';
import { Container, Graphics, Rectangle, Sprite } from 'pixi.js';
import Audio from '../../../../Audio/index.ts';
import DrawableHitCircle from '../../../../BeatmapSet/Beatmap/HitObjects/DrawableHitCircle.ts';
import DrawableSlider from '../../../../BeatmapSet/Beatmap/HitObjects/DrawableSlider.ts';
import Beatmap from '../../../../BeatmapSet/Beatmap/index.ts';
import TimelineHitObject from '../../../../BeatmapSet/Beatmap/Timeline/TimelineHitObject.ts';
import { getPixelTexture } from '../../../../BeatmapSet/Beatmap/Timeline/TimelineSlider.ts';
import TimelineTimingPoint from '../../../../BeatmapSet/Beatmap/Timeline/TimelineTimingPoint.ts';
import BeatmapSet from '../../../../BeatmapSet/index.ts';
import FullscreenConfig from '../../../../Config/FullscreenConfig.ts';
import TimelineConfig from '../../../../Config/TimelineConfig.ts';
import { inject } from '../../../../Context.ts';
import { binarySearch, gcd } from '../../../../utils.ts';
import ZContainer from '../../../core/ZContainer.ts';
import Easings from '../../../Easings.ts';

export const DEFAULT_SCALE = 1;

const BEAT_LINE_COLOR = {
	1: 0xffffff,
	2: 0xff0000,
	3: 0xb706b7,
	4: 0x3276e6,
	5: 0xe6e605,
	6: 0x843e84,
	7: 0xe6e605,
	8: 0xe6e605,
	9: 0xe6e605
};

export default class Timeline {
	container = new ZContainer({
		layout: {
			flex: 1,
			height: 80
		}
	});

	private _objectsContainer = new Container({ sortableChildren: true });

	private _dragWindow = new Graphics({ roundPixels: true })
		.rect(0, 0, 1, 80)
		.fill({ color: 0xffffff, alpha: 0.3 });

	private _timingPoints: TimelineTimingPoint[] = [];
	private _objects: TimelineHitObject[] = [];

	private _visibleObjects: number[] = [];
	private _visibleTiming: number[] = [];
	private _objectMarks = new Uint8Array(0);
	private _timingMarks = new Uint8Array(0);

	private _range = 0;

	private _ruler = new Container();
	private _rulerLines: Sprite[] = [];
	private _rulerLineCount = 0;

	private _dragWindowRange: [number, number] = [0, 0];
	private _selected = new Set<number>();
	private _clicked = false;
	private _offset = 0;

	constructor() {
		const thumb = new Graphics()
			.moveTo(0, -40)
			.lineTo(0, 40)
			.stroke(0xcdd6f4)
			.moveTo(-2, -(80 / 2))
			.lineTo(0, -(80 / 2 - 2))
			.lineTo(2, -(80 / 2 - 2))
			.lineTo(4, -(80 / 2))
			.lineTo(-2, -(80 / 2))
			.moveTo(-2, 80 / 2)
			.lineTo(-0, 80 / 2 - 2)
			.lineTo(2, 80 / 2 - 2)
			.lineTo(4, 80 / 2)
			.lineTo(-2, 80 / 2)
			.fill(0xcdd6f4);

		thumb.cacheAsTexture({ antialias: false });
		this._dragWindow.cacheAsTexture({ antialias: false });

		this.container.addChild(
			this._ruler,
			this._objectsContainer,
			this._dragWindow,
			thumb
		);

		this.container.on('layout', (layout) => {
			const { width, height } = layout.computedLayout;
			const scale = inject<TimelineConfig>('config/timeline')?.scale ?? 1;

			this._range = (width / 2) * (DEFAULT_SCALE / scale) + 120;

			this._ruler.boundsArea = new Rectangle(
				-this._range,
				0,
				this._range * 2,
				height
			);

			thumb.x = width / 2;
			thumb.y = height / 2;

			thumb.clear()
				.moveTo(0, -height / 2)
				.lineTo(0, height / 2)
				.stroke(0xcdd6f4)
				.moveTo(-3, -(height / 2))
				.lineTo(0, -(height / 2 - 3))
				.lineTo(3, -(height / 2))
				.lineTo(-3, -(height / 2))
				.moveTo(-3, height / 2)
				.lineTo(0, height / 2 - 3)
				.lineTo(3, height / 2)
				.lineTo(-3, height / 2)
				.fill(0xcdd6f4)
				.moveTo(-width / 2, height / 2)
				.lineTo(width / 2, height / 2)
				.stroke(0xa6adc8)
				.updateCacheTexture();
		});

		this.loadEventListeners();

		inject<TimelineConfig>('config/timeline')?.onChange('scale', (newScale) => {
			const width = this.container.layout?.computedLayout.width ?? 0;
			this._range = (width / 2) * (DEFAULT_SCALE / newScale) + 120;
			this.clearVisibleRuler();
		});

		inject<TimelineConfig>('config/timeline')?.onChange('divisor', () => {
			this.clearVisibleRuler();
		});

		inject<FullscreenConfig>('config/fullscreen')?.onChange(
			'fullscreen',
			(isFullscreen) => {
				if (isFullscreen) {
					this.container.triggerAnimation(
						'height',
						this.container.layout?.computedLayout.height ?? 80,
						0,
						(val) => {
							this.container.layout = { height: val };
						},
						200,
						Easings.InOut,
						() => {
							this.container.visible = false;
						}
					);
				} else {
					this.container.visible = true;
					this.container.triggerAnimation(
						'height',
						this.container.layout?.computedLayout.height ?? 0,
						80,
						(val) => {
							this.container.layout = { height: val };
						},
						200,
						Easings.InOut
					);
				}
			}
		);

		this.container.addEventListener(
			'wheel',
			(event) => {
				if (!event.altKey) return;

				event.preventDefault();

				const timeline = inject<TimelineConfig>('config/timeline');
				if (!timeline) return;

				if (event.deltaY > 0) {
					timeline.scale = Math.max(0.5, timeline.scale - 0.1);
				} else if (event.deltaY < 0) {
					timeline.scale = Math.min(1.5, timeline.scale + 0.1);
				}
			},
			{
				capture: true,
				passive: false
			}
		);
	}

	loadEventListeners() {
		this.container.on('pointerdown', (event) => {
			this._clicked = true;

			const time = this.pointerTime(event.global.x);
			const scale = inject<TimelineConfig>('config/timeline')?.scale ?? 1;
			const padding = 40 * (DEFAULT_SCALE / scale);

			this._dragWindowRange = [time, time];

			let firstSelected = -1;

			for (let i = this._visibleObjects.length - 1; i >= 0; i--) {
				const idx = this._visibleObjects[i];

				if (this.objectIntersectsTime(idx, time - padding, time + padding)) {
					firstSelected = idx;
					break;
				}
			}

			if (!event.ctrlKey || firstSelected < 0) {
				this.clearSelected();
			}

			if (firstSelected >= 0) {
				this.addSelected(firstSelected);
			}
		});

		this.container.on('globalpointermove', (event) => {
			if (!this._clicked) return;

			const { x } = this.container.toLocal(event.global);
			const width = this.container.layout?.computedLayout.width ?? 1;
			const scale = inject<TimelineConfig>('config/timeline')?.scale ?? 1;
			const currentTime = this.audioTime();

			this._offset = (x - width / 2) * (DEFAULT_SCALE / scale);
			this._dragWindowRange[1] = this._offset + currentTime;
		});

		const clearDrag = () => {
			this._clicked = false;
			this._dragWindowRange = [0, 0];
			this._dragWindow.scale.set(0, 1);
			this._offset = 0;
		};

		this.container.on('pointerup', clearDrag);
		this.container.on('pointerupoutside', clearDrag);
	}

	addSelected(idx: number) {
		this._selected.add(idx);
		const obj = this._objects[idx];
		obj?.context.consume<Beatmap>('beatmapObject')?.container.addSelected(idx);
	}

	removeSelected(idx: number) {
		this._selected.delete(idx);
		const obj = this._objects[idx];
		obj?.context
			.consume<Beatmap>('beatmapObject')
			?.container.removeSelected(idx);
	}

	loadObjects(objects: (DrawableHitCircle | DrawableSlider)[]) {
		if (this._objects.length > 0) {
			for (const obj of this._objects) {
				this._objectsContainer.removeChild(obj.container);
				obj.destroy();
			}
		}

		this._objects = objects
			.map((object) => object.timelineObject)
			.filter((object) => object !== undefined)
			.sort((a, b) => a.object.startTime - b.object.startTime);

		for (let i = 0; i < this._objects.length; i++) {
			const obj = this._objects[i];

			obj.container.zIndex = i + 1;
			obj.container.visible = false;
		}

		this._visibleObjects.length = 0;
		this._objectMarks = new Uint8Array(this._objects.length);

		this.clearVisibleRuler();
	}

	loadTimingPoints(points: TimingPoint[]) {
		if (this._timingPoints.length > 0) {
			for (const timingPoint of this._timingPoints) {
				this._objectsContainer.removeChild(timingPoint.container);
				timingPoint.destroy();
			}
		}

		this._timingPoints = points.map((point) => new TimelineTimingPoint(point));
		this._visibleTiming.length = 0;
		this._timingMarks = new Uint8Array(this._timingPoints.length);

		this.clearVisibleRuler();
	}

	update(timestamp: number) {
		this.updateTiming(timestamp);
		this.updateObjects(timestamp);
		this.updateDragSelection();
	}

	draw(timestamp: number) {
		if (
			this._clicked &&
			inject<BeatmapSet>('beatmapset')?.context.consume<Audio>('audio')
				?.state === 'PLAYING'
		) {
			this._dragWindowRange[1] = timestamp + this._offset;
		}

		const scale = inject<TimelineConfig>('config/timeline')?.scale ?? 1;
		const width = this.container.layout?.computedLayout.width ?? 0;

		const timeToX = scale / DEFAULT_SCALE;

		this._objectsContainer.x = width / 2 - timestamp * timeToX;
		this._ruler.x = width / 2 - timestamp * timeToX;

		this.drawVisibleRuler(timestamp);

		for (const idx of this._visibleTiming) {
			const point = this._timingPoints[idx];
			if (point) point.container.visible = true;
		}

		for (const idx of this._visibleObjects) {
			const obj = this._objects[idx];
			if (obj) obj.container.visible = true;
		}

		this.drawDragWindow(timestamp);
	}

	private updateObjects(timestamp: number) {
		const min = timestamp - this._range;
		const max = timestamp + this._range;

		this.updateVisibleList(
			this._visibleObjects,
			this._objectMarks,
			(idx) => this.objectIntersectsTime(idx, min, max),
			(idx) => this._objects[idx].container,
			this.firstObjectIndexAfter(min - 800),
			this._objects.length,
			(idx) => this._objects[idx].object.startTime <= max
		);
	}

	updateTiming(timestamp: number) {
		const min = timestamp - this._range;
		const max = timestamp + this._range;

		if (this._timingPoints.length === 0) return;

		const center = Math.max(
			0,
			binarySearch(
				timestamp,
				this._timingPoints,
				(mid, value) => mid.data.startTime - value
			)
		);

		let start = center;
		while (start > 0 && this._timingPoints[start - 1].data.startTime >= min) {
			start--;
		}

		this.updateVisibleList(
			this._visibleTiming,
			this._timingMarks,
			(idx) => {
				const time = this._timingPoints[idx]?.data.startTime;
				return time !== undefined && time >= min && time <= max;
			},
			(idx) => this._timingPoints[idx].container,
			start,
			this._timingPoints.length,
			(idx) => this._timingPoints[idx].data.startTime <= max
		);
	}

	private updateVisibleList(
		visible: number[],
		marks: Uint8Array,
		keep: (idx: number) => boolean,
		getContainer: (idx: number) => Container,
		start: number,
		end: number,
		shouldContinue: (idx: number) => boolean
	) {
		for (let i = visible.length - 1; i >= 0; i--) {
			const idx = visible[i];

			if (keep(idx)) continue;

			marks[idx] = 0;
			visible.splice(i, 1);

			const container = getContainer(idx);
			container.visible = false;
			this._objectsContainer.removeChild(container);
		}

		for (let idx = start; idx < end && shouldContinue(idx); idx++) {
			if (marks[idx] || !keep(idx)) continue;

			marks[idx] = 1;
			visible.push(idx);
			this._objectsContainer.addChild(getContainer(idx));
		}
	}

	private updateDragSelection() {
		if (Math.abs(this._dragWindowRange[0] - this._dragWindowRange[1]) === 0) {
			return;
		}

		const min = Math.min(this._dragWindowRange[0], this._dragWindowRange[1]);
		const max = Math.max(this._dragWindowRange[0], this._dragWindowRange[1]);

		for (const idx of this._visibleObjects) {
			if (this.objectIntersectsTime(idx, min, max)) {
				this.addSelected(idx);
			} else {
				this.removeSelected(idx);
			}
		}
	}

	private drawDragWindow(timestamp: number) {
		if (Math.abs(this._dragWindowRange[0] - this._dragWindowRange[1]) === 0) {
			return;
		}

		const min = Math.min(this._dragWindowRange[0], this._dragWindowRange[1]);
		const max = Math.max(this._dragWindowRange[0], this._dragWindowRange[1]);
		const scale = inject<TimelineConfig>('config/timeline')?.scale ?? 1;
		const width = this.container.layout?.computedLayout.width ?? 1;

		const x = (min - timestamp) / (DEFAULT_SCALE / scale);
		const w = (max - min) / (DEFAULT_SCALE / scale);

		this._dragWindow.x = width / 2 + x;
		this._dragWindow.scale.set(w, 1);
	}

	private firstObjectIndexAfter(time: number) {
		let lo = 0;
		let hi = this._objects.length;

		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			const object = this._objects[mid].object;
			const endTime = (object as Slider).endTime ?? object.startTime;

			if (endTime < time) lo = mid + 1;
			else hi = mid;
		}

		return lo;
	}

	private objectIntersectsTime(idx: number, min: number, max: number) {
		const obj = this._objects[idx];
		if (!obj) return false;

		const start = obj.object.startTime;
		const end = (obj.object as Slider).endTime ?? start;

		return start <= max && end >= min;
	}

	private pointerTime(globalX: number) {
		const { x } = this.container.toLocal({ x: globalX, y: 0 });
		const width = this.container.layout?.computedLayout.width ?? 1;
		const scale = inject<TimelineConfig>('config/timeline')?.scale ?? 1;

		return (x - width / 2) * (DEFAULT_SCALE / scale) + this.audioTime();
	}

	private audioTime() {
		return inject<BeatmapSet>('beatmapset')?.context.consume<Audio>('audio')
			?.currentTime ?? 0;
	}

	private clearSelected() {
		for (const idx of this._selected) {
			this.removeSelected(idx);
		}
	}

	private clearVisibleRuler() {
		for (let i = 0; i < this._rulerLineCount; i++) {
			this._rulerLines[i].visible = false;
		}

		this._rulerLineCount = 0;
	}

	private rentRulerLine() {
		let line = this._rulerLines[this._rulerLineCount++];

		if (!line) {
			line = new Sprite(getPixelTexture());
			line.anchor.set(0, 0);
			line.roundPixels = true;

			this._rulerLines.push(line);
			this._ruler.addChild(line);
		}

		line.visible = true;
		return line;
	}

	private setRulerLine(
		x: number,
		isDominant: boolean,
		color: number
	) {
		const line = this.rentRulerLine();

		line.x = x;
		line.y = isDominant ? 0 : 1;
		line.width = 1;
		line.height = isDominant ? 8 : 6;
		line.tint = color;
		line.alpha = 1;
	}

	private firstTimingPointIndexAtOrBefore(time: number) {
		let lo = 0;
		let hi = this._timingPoints.length;

		while (lo < hi) {
			const mid = (lo + hi) >>> 1;

			if (this._timingPoints[mid].data.startTime <= time) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}

		return Math.max(0, lo - 1);
	}

	private drawVisibleRuler(timestamp: number) {
		if (!this._timingPoints.length || !this._objects.length) {
			this.clearVisibleRuler();
			return;
		}

		const scale = inject<TimelineConfig>('config/timeline')?.scale ?? 1;
		const divisor = inject<TimelineConfig>('config/timeline')?.divisor ?? 4;
		const safeDivisor = Math.max(1, divisor | 0);

		const timeToX = scale / DEFAULT_SCALE;

		const min = timestamp - this._range;
		const max = timestamp + this._range;

		this.clearVisibleRuler();
		this._ruler.scale.y = 10;

		let ti = this.firstTimingPointIndexAtOrBefore(min);

		for (; ti < this._timingPoints.length; ti++) {
			const timing = this._timingPoints[ti].data;
			const nextTiming = this._timingPoints[ti + 1]?.data;

			const { beatLength, timeSignature, startTime } = timing;

			const sectionEnd = nextTiming
				? nextTiming.startTime
				: max;

			if (sectionEnd < min) continue;
			if (startTime > max) break;

			const step = beatLength / safeDivisor;
			if (!Number.isFinite(step) || step <= 0) continue;

			const firstIndex = Math.max(
				0,
				Math.ceil((min - startTime) / step)
			);

			const lastTime = Math.min(sectionEnd, max);

			let subdivisionIndex = firstIndex;
			let t = startTime + subdivisionIndex * step;

			while (t <= lastTime) {
				const beatSubdivision = subdivisionIndex % safeDivisor;
				const isWholeBeat = beatSubdivision === 0;
				const wholeBeatIndex = (subdivisionIndex / safeDivisor) | 0;

				const isDominant =
					isWholeBeat && wholeBeatIndex % timeSignature === 0;

				let color = 0xffffff;

				if (!isWholeBeat) {
					const denominator =
						safeDivisor / gcd(safeDivisor, beatSubdivision);

					color =
						BEAT_LINE_COLOR[
							denominator as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
							] ?? 0x929292;
				}

				this.setRulerLine(t * timeToX, isDominant, color);

				subdivisionIndex++;
				t += step;
			}
		}
	}
}