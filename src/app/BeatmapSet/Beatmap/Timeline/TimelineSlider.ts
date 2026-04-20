import {
	type Slider,
	SliderHead,
	SliderRepeat,
	SliderTail,
	SliderTick,
	SpinnerBonusTick,
	SpinnerTick,
	type StandardHitObject
} from 'osu-standard-stable';
import { BitmapText, FillGradient, Graphics } from 'pixi.js';
import type TimelineConfig from '../../../Config/TimelineConfig.ts';
import { type Context, inject } from '../../../Context.ts';
import { DEFAULT_SCALE } from '../../../UI/main/viewer/Timeline/index.ts';
import { darken } from '../../../utils.ts';
import type Beatmap from '..';
import type DrawableSlider from '../HitObjects/DrawableSlider.ts';
import type TimelineHitCircle from './TimelineHitCircle.ts';
import TimelineHitObject from './TimelineHitObject.ts';
import TimelineSliderHead from './TimelineSliderHead.ts';
import TimelineSliderRepeat from './TimelineSliderRepeat.ts';
import TimelineSliderTail from './TimelineSliderTail.ts';

const innerColor = darken([1, 1, 1, 1], 0.1);

const gradient = new FillGradient({
	start: { x: 0, y: 0 },
	end: { x: 0, y: 1 },
	colorStops: [
		{ offset: 0, color: 0xffffff },
		{
			offset: 0.5,
			color: innerColor
		},
		{ offset: 1, color: 0xffffff }
	],
	textureSpace: 'local',
	type: 'linear',
	textureSize: 256,
	wrapMode: 'clamp-to-edge'
});

const headRadialGradient = new FillGradient({
	type: 'radial',
	colorStops: [
		{
			offset: 0,
			color: innerColor
		},
		{ offset: 1, color: 0xffffff }
	]
});

const tailRadialGradient = new FillGradient({
	type: 'radial',
	colorStops: [
		{
			offset: 0,
			color: innerColor
		},
		{ offset: 1, color: 0xffffff }
	]
});

headRadialGradient.buildRadialGradient();
headRadialGradient.transform.scale(2, 1);

tailRadialGradient.buildRadialGradient();
tailRadialGradient.transform.scale(2, 1);
tailRadialGradient.transform.translate(-1, 0);

export default class TimelineSlider extends TimelineHitObject {
	circles: TimelineHitCircle[] = [];
	body: Graphics = new Graphics({ alpha: 0.7 });
	select: Graphics;

	length = 0;

	constructor(object: Slider) {
		super(object);
		this.object = object;

		this.length =
			object.duration /
			(DEFAULT_SCALE / (inject<TimelineConfig>('config/timeline')?.scale ?? 1));

		this.select = new Graphics({ visible: false });

		for (const object of this.object.nestedHitObjects
		.filter(
			(object) =>
				!(
					object instanceof SliderTick ||
					object instanceof SpinnerTick ||
					object instanceof SpinnerBonusTick
				)
		)
		.map((object) => {
			const obj = object.clone();
			obj.startTime = obj.startTime - this.object.startTime;
			return obj;
		})
		.toReversed()) {
			const obj =
				object instanceof SliderHead
					? new TimelineSliderHead(object, this.object as Slider).hook(
						this.context
					)
					: object instanceof SliderTail
						? new TimelineSliderTail(object).hook(this.context)
						: object instanceof SliderRepeat
							? new TimelineSliderRepeat(object).hook(this.context)
							: new TimelineSliderTail(object as unknown as SliderTail).hook(
								this.context
							);

			obj.container.y = 0;
			obj.container.visible = true;

			this.circles.push(obj);
		}

		this.container.addChild(
			this.body,
			...this.circles.map((circle) => circle.container),
			this.select
		);

		this.updateCircles();
		this.refreshSprite();

		inject<TimelineConfig>('config/timeline')?.onChange('scale', () => {
			this.updateCircles();
			this.refreshSprite();
		});
	}

	override get object() {
		return super.object as Slider;
	}

	override set object(val: Slider) {
		super.object = val;
		this.length =
			val.duration /
			(DEFAULT_SCALE / (inject<TimelineConfig>('config/timeline')?.scale ?? 1));

		if (!this.circles?.length) return;

		let idx = 0;
		for (const object of val.nestedHitObjects
		.filter(
			(object) =>
				!(
					object instanceof SliderTick ||
					object instanceof SpinnerTick ||
					object instanceof SpinnerBonusTick
				)
		)
		.map((object) => {
			const obj = object.clone();
			obj.startTime = obj.startTime - val.startTime;
			return obj;
		})
		.toReversed()) {
			this.circles[idx++].object = object as unknown as StandardHitObject;
		}

		this.updateCircles();
		this.refreshSprite();
	}

	override set isSelected(val: boolean) {
		super.isSelected = val;
		for (const circle of this.circles) {
			circle.isSelected = val;
		}
		this.refreshSprite();
	}

	updateVelocity() {
		const beatmap = this.context.consume<Beatmap>('beatmapObject');
		if (!beatmap) return;

		const difficultyPoint = beatmap.data.controlPoints.difficultyPointAt(
			this.object.startTime
		);
		const velocity = new BitmapText({
			text: `${difficultyPoint.sliderVelocity.toFixed(2)}x`,
			style: {
				fontFamily: 'Rubik',
				fontSize: 10,
				fill: 0xa6e3a1
			},
			anchor: {
				x: 0,
				y: 0.5
			},
			x: 5,
			y: -32
		});

		this.container.addChild(velocity);
	}

	refreshSprite() {
		this.length =
			(this.object as Slider).duration /
			(DEFAULT_SCALE / (inject<TimelineConfig>('config/timeline')?.scale ?? 1));

		this.select
		.clear()
		.roundRect(-25, -25, this.length + 50, 50, 25)
		.stroke({
			width: 50 * 0.1,
			cap: 'round',
			color: 0xffc02b,
			alignment: 1
		});

		this.select.visible =
			(this.skinManager?.getCurrentSkin().config.General.Argon ?? false) &&
			this.isSelected;

		if (this.skinManager?.getCurrentSkin().config.General.Argon) {
			this.body
			.clear()
			.moveTo(0, 0)
			.lineTo(this.length, 0)
			.stroke({
				width: 50,
				cap: 'round',
				color: 0xb6b6b6
			})
			.moveTo(0, 0)
			.lineTo(this.length, 0)
			.stroke({
				width: 50 * 0.8,
				cap: 'round',
				color: 'white'
			});
			this.body.alpha = 1;
		} else {
			this.body
			.clear()
			.arc(0, 0, (25 * 236) / 256, Math.PI / 2, (3 * Math.PI) / 2)
			.fill(headRadialGradient)
			.rect(0, -((25 * 236) / 256), this.length, (50 * 236) / 256)
			.fill(gradient)
			.moveTo(this.length, 0)
			.arc(
				this.length,
				0,
				(25 * 236) / 256,
				(3 * Math.PI) / 2,
				(5 * Math.PI) / 2
			)
			.fill(tailRadialGradient);
			this.body.alpha = 0.7;
		}

		const color = this.context.consume<DrawableSlider>('object')?.color;
		this.body.tint = color?.includes('rgb')
			? (color ?? 'rgb(0, 0, 0)')
			: color?.includes('#')
				? (color ?? 0)
				: `rgb(${color ?? '0,0,0'})`;

		for (const object of this.circles) {
			object.refreshSprite();
		}
	}

	override hook(context: Context) {
		super.hook(context);

		for (const object of this.circles) {
			object.refreshSprite();
		}
		this.refreshSprite();

		return this;
	}

	getTimeRange(): { start: number; end: number } {
		return {
			start: this.object.startTime - 30 * 5,
			end: (this.object as Slider).endTime + 30 * 5
		};
	}

	updateCircles() {
		const scale = inject<TimelineConfig>('config/timeline')?.scale ?? 1;
		for (const object of this.circles.filter(
			(object) => object instanceof TimelineSliderTail || TimelineSliderRepeat
		)) {
			try
			{
				object.container.x =
					(object.object.startTime +
						(object instanceof TimelineSliderTail &&
						!(object instanceof TimelineSliderRepeat)
							? 36
							: 0)) /
					(DEFAULT_SCALE / scale);
			} catch {
				console.log(object.object);
			}
		}
	}
}