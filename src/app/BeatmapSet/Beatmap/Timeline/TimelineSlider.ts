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
import { BitmapText, Color, type ColorSource, Container, Rectangle, Sprite, Texture } from 'pixi.js';
import Beatmap from '..';
import TimelineConfig from '../../../Config/TimelineConfig.ts';
import { type Context, inject } from '../../../Context.ts';
import { DEFAULT_SCALE } from '../../../UI/main/viewer/Timeline/index.ts';
import DrawableSlider from '../HitObjects/DrawableSlider.ts';
import TimelineHitCircle from './TimelineHitCircle.ts';
import TimelineHitObject from './TimelineHitObject.ts';
import TimelineSliderHead from './TimelineSliderHead.ts';
import TimelineSliderRepeat from './TimelineSliderRepeat.ts';
import TimelineSliderTail from './TimelineSliderTail.ts';

const DEFAULT_DIAMETER = (50 * 236) / 256;
const ARGON_OUTLINE_DIAMETER = 50;
const ARGON_FILL_DIAMETER = 40;

const DEFAULT_ALPHA = 0.7;
const ARGON_ALPHA = 1;

const ARGON_OUTLINE_TINT = 0xb6b6b6;

const SELECT_DIAMETER = 50;
const SELECT_STROKE = 5;
const SELECT_TINT = 0xffc02b;

const TEXTURE_DIAMETER = 256;
const INNER_GRADIENT_COLOR = '#e6e6e6';

let solidCapTexture: Texture | null = null;
let defaultCapTexture: Texture | null = null;
let defaultMidTexture: Texture | null = null;
let solidPixelTexture: Texture | null = null;
let selectCapTexture: Texture | null = null;
let selectMidTexture: Texture | null = null;

function createTexture(
	label: string,
	width: number,
	height: number,
	draw: (ctx: CanvasRenderingContext2D) => void
): Texture {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;

	const ctx = canvas.getContext('2d');
	if (!ctx) {
		throw new Error(`Failed to create ${label}`);
	}

	ctx.clearRect(0, 0, width, height);
	draw(ctx);

	const texture = Texture.from(canvas);
	texture.label = label;

	return texture;
}

function getSolidCapTexture(): Texture {
	if (solidCapTexture) return solidCapTexture;

	const diameter = TEXTURE_DIAMETER;
	const radius = diameter / 2;

	solidCapTexture = createTexture(
		'timeline-slider-solid-cap',
		radius,
		diameter,
		(ctx) => {
			ctx.fillStyle = '#ffffff';

			ctx.beginPath();
			ctx.arc(radius, radius, radius, Math.PI / 2, Math.PI * 1.5);
			ctx.closePath();
			ctx.fill();
		}
	);

	return solidCapTexture;
}

function getDefaultCapTexture(): Texture {
	if (defaultCapTexture) return defaultCapTexture;

	const diameter = TEXTURE_DIAMETER;
	const radius = diameter / 2;

	defaultCapTexture = createTexture(
		'timeline-slider-default-cap',
		radius,
		diameter,
		(ctx) => {
			const gradient = ctx.createRadialGradient(
				radius,
				radius,
				0,
				radius,
				radius,
				radius
			);

			gradient.addColorStop(0, INNER_GRADIENT_COLOR);
			gradient.addColorStop(1, '#ffffff');

			ctx.fillStyle = gradient;

			ctx.beginPath();
			ctx.arc(radius, radius, radius, Math.PI / 2, Math.PI * 1.5);
			ctx.closePath();
			ctx.fill();
		}
	);

	return defaultCapTexture;
}

function getDefaultMidTexture(): Texture {
	if (defaultMidTexture) return defaultMidTexture;

	defaultMidTexture = createTexture(
		'timeline-slider-default-mid',
		1,
		TEXTURE_DIAMETER,
		(ctx) => {
			const gradient = ctx.createLinearGradient(0, 0, 0, TEXTURE_DIAMETER);

			gradient.addColorStop(0, '#ffffff');
			gradient.addColorStop(0.5, INNER_GRADIENT_COLOR);
			gradient.addColorStop(1, '#ffffff');

			ctx.fillStyle = gradient;
			ctx.fillRect(0, 0, 1, TEXTURE_DIAMETER);
		}
	);

	return defaultMidTexture;
}

export function getPixelTexture(): Texture {
	if (solidPixelTexture) return solidPixelTexture;

	const cap = getSolidCapTexture();
	const radius = TEXTURE_DIAMETER / 2;

	solidPixelTexture = new Texture({
		source: cap.source,
		frame: new Rectangle(radius - 2, radius, 1, 1)
	});

	return solidPixelTexture;
}

function getSelectCapTexture(): Texture {
	if (selectCapTexture) return selectCapTexture;

	const outerRadius = TEXTURE_DIAMETER / 2;
	const stroke = (TEXTURE_DIAMETER / SELECT_DIAMETER) * SELECT_STROKE;
	const centerRadius = outerRadius - stroke / 2;

	selectCapTexture = createTexture(
		'timeline-slider-select-cap',
		outerRadius,
		TEXTURE_DIAMETER,
		(ctx) => {
			ctx.strokeStyle = '#ffffff';
			ctx.lineWidth = stroke;
			ctx.lineCap = 'butt';

			ctx.beginPath();
			ctx.arc(
				outerRadius,
				outerRadius,
				centerRadius,
				Math.PI / 2,
				Math.PI * 1.5
			);
			ctx.stroke();
		}
	);

	return selectCapTexture;
}

function getSelectMidTexture(): Texture {
	if (selectMidTexture) return selectMidTexture;

	const textureHeight = TEXTURE_DIAMETER;
	const stroke = (TEXTURE_DIAMETER / SELECT_DIAMETER) * SELECT_STROKE;

	selectMidTexture = createTexture(
		'timeline-slider-select-mid',
		1,
		textureHeight,
		(ctx) => {
			ctx.fillStyle = '#ffffff';

			ctx.fillRect(0, 0, 1, stroke);
			ctx.fillRect(0, textureHeight - stroke, 1, stroke);
		}
	);

	return selectMidTexture;
}

export default class TimelineSlider extends TimelineHitObject {
	circles: TimelineHitCircle[] = [];

	body = new Container();
	select = new Container({ visible: false });
	length = 0;
	private readonly outlineHead = new Sprite(getSolidCapTexture());
	private readonly outlineMid = new Sprite(getPixelTexture());
	private readonly outlineTail = new Sprite(getSolidCapTexture());
	private readonly fillHead = new Sprite(getDefaultCapTexture());
	private readonly fillMid = new Sprite(getDefaultMidTexture());
	private readonly fillTail = new Sprite(getDefaultCapTexture());
	private readonly selectHead = new Sprite(getSelectCapTexture());
	private readonly selectMid = new Sprite(getSelectMidTexture());
	private readonly selectTail = new Sprite(getSelectCapTexture());

	constructor(object: Slider) {
		super(object);
		this.object = object;

		this.length =
			object.duration /
			(DEFAULT_SCALE / (inject<TimelineConfig>('config/timeline')?.scale ?? 1));

		this.setupSprites();

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

			this.lifetime.use(obj, c => c.destroy());
			this.circles.push(obj);
		}

		this.container.addChild(
			this.body,
			...this.circles.map((circle) => circle.container),
			this.select
		);

		this.updateCircles();
		this.refreshSprite();

		this.lifetime.use(
			inject<TimelineConfig>('config/timeline')?.onChange('scale', () => {
				this.updateCircles();
				this.refreshSprite();
			})
		);
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

		const label = `${difficultyPoint.sliderVelocity.toFixed(2)}x`;
		const velocity = new BitmapText({
			text: label,
			label,
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
			this.object.duration /
			(DEFAULT_SCALE / (inject<TimelineConfig>('config/timeline')?.scale ?? 1));

		const isArgon =
			this.skinManager?.getCurrentSkin().config.General.Argon ?? false;

		const tint = this.context.consume<DrawableSlider>('object')?.color ?? 'rgb(0,0,0)';

		this.body.alpha = isArgon ? ARGON_ALPHA : DEFAULT_ALPHA;

		this.fillHead.texture = isArgon
			? getSolidCapTexture()
			: getDefaultCapTexture();

		this.fillMid.texture = isArgon
			? getPixelTexture()
			: getDefaultMidTexture();

		this.fillTail.texture = this.fillHead.texture;

		this.setCapsule(
			this.outlineHead,
			this.outlineMid,
			this.outlineTail,
			this.length,
			ARGON_OUTLINE_DIAMETER,
			new Color(ARGON_OUTLINE_TINT).multiply(tint),
			isArgon
		);

		this.setCapsule(
			this.fillHead,
			this.fillMid,
			this.fillTail,
			this.length,
			isArgon ? ARGON_FILL_DIAMETER : DEFAULT_DIAMETER,
			tint,
			true
		);

		this.select.visible = isArgon && this._isSelected;

		this.setCapsule(
			this.selectHead,
			this.selectMid,
			this.selectTail,
			this.length,
			SELECT_DIAMETER,
			SELECT_TINT,
			this.select.visible
		);

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
			end: this.object.endTime + 30 * 5
		};
	}

	updateCircles() {
		const scale = inject<TimelineConfig>('config/timeline')?.scale ?? 1;

		for (const object of this.circles.filter(
			(object) =>
				object instanceof TimelineSliderTail ||
				object instanceof TimelineSliderRepeat
		)) {
			object.container.x =
				(object.object.startTime +
					(object instanceof TimelineSliderTail &&
					!(object instanceof TimelineSliderRepeat)
						? 36
						: 0)) /
				(DEFAULT_SCALE / scale);
		}
	}

	private setupSprites() {
		this.body.addChild(
			this.outlineMid,
			this.outlineHead,
			this.outlineTail,
			this.fillMid,
			this.fillHead,
			this.fillTail
		);

		this.select.addChild(
			this.selectMid,
			this.selectHead,
			this.selectTail
		);

		this.setupCap(this.outlineHead);
		this.setupCap(this.outlineTail);
		this.setupCap(this.fillHead);
		this.setupCap(this.fillTail);
		this.setupCap(this.selectHead);
		this.setupCap(this.selectTail);

		this.outlineMid.anchor.set(0, 0.5);
		this.fillMid.anchor.set(0, 0.5);
		this.selectMid.anchor.set(0, 0.5);
	}

	private setupCap(sprite: Sprite) {
		sprite.anchor.set(1, 0.5);
	}

	private setCapsule(
		head: Sprite,
		mid: Sprite,
		tail: Sprite,
		length: number,
		diameter: number,
		tint: ColorSource,
		visible: boolean
	) {
		const safeLength = Math.max(0, length);
		const safeDiameter = Math.max(0, diameter);
		const radius = safeDiameter * 0.5;

		head.visible = visible;
		mid.visible = visible;
		tail.visible = visible;

		head.tint = tint;
		mid.tint = tint;
		tail.tint = tint;

		mid.position.set(0, 0);
		mid.width = safeLength;
		mid.height = safeDiameter;

		head.scale.x = 1;
		head.position.set(0, 0);
		head.width = radius;
		head.height = safeDiameter;

		tail.scale.x = 1;
		tail.position.set(safeLength, 0);
		tail.width = radius;
		tail.height = safeDiameter;
		tail.scale.x = -Math.abs(tail.scale.x);
	}
}