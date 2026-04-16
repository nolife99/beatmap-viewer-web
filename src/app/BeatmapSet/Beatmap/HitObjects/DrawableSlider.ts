import {
	HitResult,
	LegacyReplayFrame,
	HitSample as Sample,
	Vector2,
} from "osu-classes";
import {
	type Slider,
	SliderHead,
	SliderRepeat,
	SliderTail,
	SliderTick,
	StandardHitObject,
} from "osu-standard-stable";
import {
	AlphaFilter,
	Buffer,
	BufferUsage,
	Container,
	Geometry,
	GpuProgram,
	Graphics,
	Mesh,
	RenderLayer,
	Shader,
} from "pixi.js";
import type BeatmapSet from "@/BeatmapSet";
import type ExperimentalConfig from "@/Config/ExperimentalConfig";
import type GameplayConfig from "@/Config/GameplayConfig";
import type RendererConfig from "@/Config/RendererConfig";
import type SkinningConfig from "@/Config/SkinningConfig";
import { type Context, inject } from "@/Context";
import {
	refreshColor as argonRefreshColor,
} from "@/Skinning/Argon/ArgonSlider";
import {
	refreshColor as legacyRefreshColor,
} from "@/Skinning/Legacy/LegacySlider";
import type Skin from "@/Skinning/Skin";
import type SkinManager from "@/Skinning/SkinManager";
import type ProgressBar from "@/UI/main/controls/ProgressBar";
import type Gameplays from "@/UI/main/viewer/Gameplay/Gameplays";
import HitSample from "../../../Audio/HitSample";
import { Clamp, darken, lighten } from "@/utils.ts";
import type Beatmap from "..";
import type { SliderEvaluation } from "../Replay";
import TimelineSlider from "../Timeline/TimelineSlider";
import calculateSliderProgress, {type SliderProgressResult} from "./CalculateSliderProgress";
import createGeometry from "./CreateSliderGeometry";
import type DrawableHitCircle from "./DrawableHitCircle";
import DrawableHitObject, {
	type IHasApproachCircle,
} from "./DrawableHitObject";
import DrawableJudgement from "./DrawableJudgement";
import DrawableSliderBall from "./DrawableSliderBall";
import DrawableSliderFollowCircle from "./DrawableSliderFollowCircle";
import DrawableSliderHead from "./DrawableSliderHead";
import DrawableSliderRepeat from "./DrawableSliderRepeat";
import DrawableSliderTail, { TAIL_LENIENCY } from "./DrawableSliderTail";
import DrawableSliderTick from "./DrawableSliderTick";
import fragment from "./Shaders/sliderShader.frag?raw";
import vertex from "./Shaders/sliderShader.vert?raw";
import gpuSrc from "./Shaders/sliderShader.wgsl?raw";
import {sharedUpdate} from "@/Skinning/Shared/Slider.ts";

const GL = { vertex, fragment };
const GPU = GpuProgram.from({
	vertex: {
		source: gpuSrc,
		entryPoint: "vsMain",
	},
	fragment: {
		source: gpuSrc,
		entryPoint: "fsMain",
	},
});

const COLOR: [number, number, number, number] = [
	69 / 255,
	71 / 255,
	90 / 255,
	0,
];

export default class DrawableSlider
	extends DrawableHitObject
	implements IHasApproachCircle
{
	private _geometry: Geometry = new Geometry({
		attributes: {
			aPosition: {
				buffer: new Buffer({
					data: new Float32Array([]),
					usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
				}),
				format: "float32x3",
				stride: 4 * 3,
			},
		},
		indexBuffer: []
	});
	public _shader = Shader.from({
		gl: GL,
		gpu: GPU,
		resources: {
			customUniforms: {
				borderColor: {
					value: [205 / 255, 214 / 255, 244 / 255, 1.0],
					type: "vec4<f32>",
				},
				innerColor: { value: lighten(COLOR, 0.5), type: "vec4<f32>" },
				outerColor: { value: darken(COLOR, 0.1), type: "vec4<f32>" },
				borderWidth: { value: 0.128, type: "f32" },
				bodyAlpha: { value: 0.7, type: "f32" },
			},
		},
	});
	public _selectShader = Shader.from({
		gl: GL,
		gpu: GPU,
		resources: {
			customUniforms: {
				borderColor: {
					value: [205 / 255, 214 / 255, 244 / 255, 1.0],
					type: "vec4<f32>",
				},
				innerColor: { value: lighten(COLOR, 0.5), type: "vec4<f32>" },
				outerColor: { value: darken(COLOR, 0.1), type: "vec4<f32>" },
				borderWidth: { value: 0.128, type: "f32" },
				bodyAlpha: { value: 0.0, type: "f32" },
			},
		},
	});
	_alphaFilter = new AlphaFilter();

	public drawableCircles: DrawableHitObject[] = [];
	public body: Mesh<Geometry, Shader> = new Mesh({
		geometry: this._geometry,
		shader: this._shader,
		filters: [this._alphaFilter],
		blendMode:
			inject<RendererConfig>("config/renderer")?.renderer === "webgl"
				? "none"
				: "max"
	});

	public select = new Container();

	public _baseGeometry: Geometry = new Geometry({
		attributes: {
			aPosition: {
				buffer: new Buffer({
					data: new Float32Array([]),
					usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
				}),
				format: "float32x3",
				stride: 4 * 3,
			},
		},
		indexBuffer: []
	});
	public selectBody: Mesh<Geometry, Shader> = new Mesh({
		geometry: this._baseGeometry,
		shader: this._selectShader,
		filters: [new AlphaFilter({ alpha: 1 })],
		blendMode:
			inject<RendererConfig>("config/renderer")?.renderer === "webgl"
				? "none"
				: "max"
	});

	path: SliderProgressResult = {
		points: [], length: 0
	};

	ball: DrawableSliderBall;
	followCircle: DrawableSliderFollowCircle;

	nodes: Graphics = new Graphics({ visible: false });

	private sliderWhistleSample: HitSample;
	private sliderSlideSample: HitSample;

	container = new Container();

	timelineObject: TimelineSlider;

	private layer = new RenderLayer();
	private layer2 = new RenderLayer();

	wrapper = new Container();

	judgement: DrawableJudgement;

	constructor(object: Slider) {
		super(object);
		this.object = object;
		this.context.provide<DrawableSlider>("drawable", this);

		let idx = -1;
		this.drawableCircles.push(
			...object.nestedHitObjects
				.filter((object) => object instanceof StandardHitObject)
				.map((object) => {
					if (object instanceof SliderTick)
						return new DrawableSliderTick(
							object,
							this.object,
							this.object.samples.find(
								(sample) => sample.hitSound === "Normal",
							)!,
						).hook(this.context);

					idx++;

					if (object instanceof SliderRepeat)
						return new DrawableSliderRepeat(
							object,
							this.object,
							this.object.nodeSamples[idx],
						).hook(this.context);

					if (object instanceof SliderTail)
						return new DrawableSliderTail(
							object,
							this.object,
							this.object.nodeSamples[idx],
						).hook(this.context);

					if (object instanceof SliderHead)
						return new DrawableSliderHead(
							object,
							this.object,
							this.object.nodeSamples[idx],
						).hook(this.context);

					return null;
				})
				.filter((object) => object !== null),
		);

		this.body.state.depthTest = true;
		this.selectBody.state.depthTest = true;

		this.context.provide("slider", this);

		this.ball = new DrawableSliderBall(this.object).hook(this.context);
		this.followCircle = new DrawableSliderFollowCircle(this.object).hook(this.context);

		this.wrapper.addChild(
			this.body,
			...this.drawableCircles
				.slice(1)
				.toReversed()
				.map((circle) => circle.container),
			this.followCircle.container,
			this.ball.container,
			this.drawableCircles[0].container,
			this.layer,
			this.layer2,
		);

		const judgementLayer = new RenderLayer();
		this.container.addChild(judgementLayer, this.wrapper);
		this.select.addChild(this.selectBody);

		for (const drawable of this.drawableCircles.toReversed()) {
			const d = drawable as DrawableHitCircle;

			if (d instanceof DrawableSliderRepeat) {
				this.layer.attach(d.reverseArrow);
			}

			if (d instanceof DrawableSliderHead && d.defaults) {
				this.layer2.attach(d.defaults.container);
			}

			if (d.select) this.select.addChild(d.select);
		}

		this.select.addChild(this.nodes);

		const whistleSample = new Sample();
		whistleSample.hitSound = "sliderwhistle";
		this.sliderWhistleSample = new HitSample([whistleSample]).hook(
			this.context,
		);

		const slideSample = new Sample();
		slideSample.hitSound = "sliderslide";
		this.sliderSlideSample = new HitSample([slideSample]).hook(this.context);

		this.refreshSprite();
		this.skinEventCallback = this.skinManager?.addSkinChangeListener(() =>
			this.refreshSprite(),
		);
		this.gameplaysEventCallback = inject<Gameplays>(
			"ui/main/viewer/gameplays",
		)?.on("change", () => this.refreshColor());
		inject<ExperimentalConfig>("config/experimental")?.onChange(
			"overlapGameplays",
			() => this.refreshColor(),
		);

		this._shader.resources.customUniforms.uniforms.scale =
			(object.radius / 54.4) * (236 / 256);

		this.timelineObject = new TimelineSlider(object).hook(this.context);

		this.judgement = new DrawableJudgement(this);
		judgementLayer.attach(this.judgement.container);
		this.container.addChild(this.judgement.container);
		this.judgement.container.position.x = object.endPosition.add(
			object.stackedOffset,
		).x;
		this.judgement.container.position.y = object.endPosition.add(
			object.stackedOffset,
		).y;
		this.judgement.container.scale.set(object.scale);
	}

	private _isHover = false;
	get isHover() {
		return this._isHover;
	}
	set isHover(val: boolean) {
		this._isHover = val;
		this.nodes.visible = val || this.isSelected;
	}

	private _isSelected = false;
	get isSelected() {
		return this._isSelected;
	}
	set isSelected(val: boolean) {
		this._isSelected = val;
		this.select.visible = val;
		this.nodes.visible = val;
		for (const circle of this.drawableCircles) {
			if (
				circle instanceof DrawableSliderHead ||
				circle instanceof DrawableSliderTail ||
				circle instanceof DrawableSliderRepeat
			)
				circle.select.visible = val;
		}
	}

	private _object!: Slider;
	get object() {
		return this._object;
	}

	set object(val: Slider) {
		this._object = val;

		this.body.x = val.startPosition.x + val.stackedOffset.x;
		this.body.y = val.startPosition.y + val.stackedOffset.y;
		this.selectBody.x = val.startPosition.x + val.stackedOffset.x;
		this.selectBody.y = val.startPosition.y + val.stackedOffset.y;

		this.nodes.x = val.startPosition.x + val.stackedOffset.x;
		this.nodes.y = val.startPosition.y + val.stackedOffset.y;

		const nodes = val.nestedHitObjects.filter(
			(object) => object instanceof StandardHitObject,
		);

		let idx = -1;
		for (let i = 0; i < this.drawableCircles.length; i++) {
			const circle = this.drawableCircles[i];
			circle.object = val;

			if (circle instanceof DrawableSliderTick) {
				circle.updateObjects(
					nodes[i] as SliderTick,
					val,
					// biome-ignore lint/style/noNonNullAssertion: Always Available
					val.samples.find((sample) => sample.hitSound === "Normal")!,
				);
				continue;
			}

			idx++;
			if (circle instanceof DrawableSliderHead) {
				circle.updateObjects?.(nodes[i], val, val.nodeSamples[idx]);
			}
		}
		if (this.ball) this.ball.object = val;
		if (this.followCircle) this.followCircle.object = val;
		if (this.timelineObject) this.timelineObject.object = val;

		if (this.judgement) {
			this.judgement.container.position.x = val.endPosition.add(
				val.stackedOffset,
			).x;
			this.judgement.container.position.y = val.endPosition.add(
				val.stackedOffset,
			).y;
			this.judgement.container.scale.set(val.scale);
		}

		const path = calculateSliderProgress(this.object.path, 0, 1, this.path.points);
		if (!path.length) return;

		this.path = path;

		this.nodes.clear();
		for (let i = 0; i < val.path.controlPoints.length; i++) {
			const point = val.path.controlPoints[i];
			if (i === 0) {
				this.nodes.moveTo(point.position.x, point.position.y);
			} else {
				this.nodes.lineTo(point.position.x, point.position.y);
			}
		}
		this.nodes.stroke({ width: 1, alignment: 0.5, color: 0xefefef });

		for (let i = 0; i < val.path.controlPoints.length; i++) {
			const p = val.path.controlPoints[i];
			if (i === 0 || p.type === null) {
				this.nodes.circle(p.position.x, p.position.y, 2);
			}
		}
		this.nodes.fill(0xefefef);

		for (let i = 0; i < val.path.controlPoints.length; i++) {
			const p = val.path.controlPoints[i];
			if (i !== 0 && p.type !== null) {
				this.nodes.circle(p.position.x, p.position.y, 2);
			}
		}
		this.nodes.fill(0xff0000);

		/* for (let i = 0; i < path.length; i++) {
			const point = path.points[i];
			if (i === 0) {
				this.nodes.moveTo(point.x, point.y);
			} else {
				this.nodes.lineTo(point.x, point.y);
			}
		}
		this.nodes.stroke({ width: 1, alignment: 0.5, color: 0xefefef });

		for (let i = 0; i < path.length; i++) {
			const p = path.points[i];
			const prog = 1 - i / path.length;
			this.nodes.circle(p.x, p.y, 2).fill([prog, prog, prog, 1]);
		} */

		const { positions, indices } = createGeometry(
			path,
			val.radius *
				(236 / 256) *
				(inject<SkinManager>("skinManager")?.getCurrentSkin()?.config.General
					.Argon
					? 0.95
					: 1),
			this._baseGeometry.attributes.aPosition.buffer.data,
			this._baseGeometry.indexBuffer.data
		);
		this._baseGeometry.attributes.aPosition.buffer.data = positions;
		this._baseGeometry.indexBuffer.data = indices;

		if (this.object.path.curveType === 'B')
			console.log(`Slider at ${val.startTime} has ${indices.length} points`);

		if (this._geometry.attributes.aPosition.buffer.data.length !== positions.length)
			this._geometry.attributes.aPosition.buffer.data = new Float32Array(positions.length);
		if (this._geometry.indexBuffer.data.length !== indices.length)
			this._geometry.indexBuffer.data = new Uint32Array(indices.length);
	}

	checkCollide(x: number, y: number, time: number) {
		const obj = this.object;
		if (time < obj.startTime - obj.timePreempt || time > obj.endTime + 240) {
			return false;
		}

		const radiusSq = (64 * obj.scale) ** 2;
		const objX = obj.startX + obj.stackedOffset.x;
		const objY = obj.startY + obj.stackedOffset.y;

		const pathPts = this.path.points;
		const len = pathPts.length;

		for (let i = 0; i < len - 1; i++) {
			const p1 = pathPts[i];
			const p2 = pathPts[i + 1];

			const x1 = p1.x + objX;
			const y1 = p1.y + objY;
			const x2 = p2.x + objX;
			const y2 = p2.y + objY;

			const dx = x2 - x1;
			const dy = y2 - y1;
			const l2 = dx * dx + dy * dy;

			if (l2 === 0) continue;

			let t = ((x - x1) * dx + (y - y1) * dy) / l2;
			t = Math.max(0, Math.min(1, t));

			const closestX = x1 + t * dx;
			const closestY = y1 + t * dy;

			const distSq = (x - closestX) ** 2 + (y - closestY) ** 2;
			if (distSq < radiusSq) return true;
		}

		return false;
	}

	hook(context: Context) {
		super.hook(context);

		for (const object of this.drawableCircles.filter(
			(object) =>
				object instanceof DrawableSliderHead ||
				object instanceof DrawableSliderTail ||
				object instanceof DrawableSliderRepeat ||
				object instanceof DrawableSliderTick,
		)) {
			object.refreshSprite();
		}
		this.ball.refreshSprite();
		this.followCircle.refreshSprite();
		this.refreshSprite();
		this.timelineObject.updateVelocity();

		return this;
	}

	trackColor: number[] = [0, 0, 0];
	borderColor: number[] = [0, 0, 0];
	color = "0,0,0";

	refreshSprite() {
		const skin = this.skinManager?.getCurrentSkin();
		if (!skin) return;

		if (skin.config.General.Argon) {
			argonRefreshColor(this);
			this.timelineObject?.refreshSprite();
		} else {
			legacyRefreshColor(this);
			this.timelineObject?.refreshSprite();
		}

		const path = calculateSliderProgress(this.object.path, 0, 1, this.path.points);
		if (path.length === 0) return;

		const { positions, indices } = createGeometry(
			path,
			this.object.radius *
			(236 / 256) *
			(skin.config.General.Argon
				? 0.95
				: 1),
			this._baseGeometry.attributes.aPosition.buffer.data,
			this._baseGeometry.indexBuffer.data
		);
		this._baseGeometry.attributes.aPosition.buffer.data = positions;
		this._baseGeometry.indexBuffer.data = indices;
	}

	refreshColor() {
		const skin = this.skinManager?.getCurrentSkin();
		if (!skin) return;

		if (skin.config.General.Argon) {
			argonRefreshColor(this);
		} else {
			legacyRefreshColor(this);
		}
	}

	getColor(skin: Skin) {
		const beatmap = this.context.consume<Beatmap>("beatmapObject");
		if (
			beatmap?.data?.colors.comboColors.length &&
			!inject<SkinningConfig>("config/skinning")?.disableBeatmapSkin
		) {
			const colors = beatmap.data.colors.comboColors;
			const comboIndex = this.object.comboIndexWithOffsets % colors.length;

			return `rgb(${colors[comboIndex].red},${colors[comboIndex].green},${colors[comboIndex].blue})`;
		}

		const comboIndex = this.object.comboIndexWithOffsets % skin.colorsLength;
		// biome-ignore lint/suspicious/noExplicitAny: It is complicated
		const color = (skin.config.Colours as any)[
			`Combo${comboIndex + 1}`
		] as string;
		return `rgb(${color})`;
	}

	get approachCircle() {
		return (this.drawableCircles[0] as DrawableHitCircle).approachCircle;
	}

	getTimeRange(): { start: number; end: number } {
		return {
			start: this.object.startTime - this.object.timePreempt,
			end: this.object.endTime + 800,
		};
	}

	playHitSound(time: number): void {
		const beatmap = this.context.consume<Beatmap>("beatmapObject");
		const isSeeking =
			inject<ProgressBar>("ui/main/controls/progress")?.isSeeking ||
			inject<BeatmapSet>("beatmapset")?.isSeeking;
		if (!beatmap || isSeeking) return;

		for (const object of this.drawableCircles) {
			const offset =
				object instanceof DrawableSliderTail &&
				!(object instanceof DrawableSliderRepeat)
					? TAIL_LENIENCY
					: 0;
			object.playHitSound(time, offset);
		}

		const currentSamplePoint = beatmap.getNearestSamplePoint(
			this.object.startTime,
		);

		if (this.object.hitSound !== 0) {
			this.sliderWhistleSample.playLoop(
				currentSamplePoint,
				time, this.object.startTime, this.object.endTime
			);
		}

		this.sliderSlideSample.playLoop(
			currentSamplePoint,
			time, this.object.startTime, this.object.endTime
		);
	}

	lastGeometryState = { head: Infinity, tail: -Infinity, scale: -Infinity };
	updateGeometry(progressHead = 0, progressTail = 0, scale = 1) {
		const snakeIn = inject<GameplayConfig>("config/gameplay")?.snakeInSlider;
		const snakeOut = inject<GameplayConfig>("config/gameplay")?.snakeOutSlider;

		let head = progressHead;
		let tail = progressTail;

		if (progressHead === Math.abs(progressTail)) {
			const checkDistance = 0.1 / this.object.path.distance;
			head = Math.min(1 - checkDistance, progressHead);
			tail = Math.min(1, progressHead + checkDistance);
		}

		const isReversing = 1 / progressTail < 0;
		head = (isReversing ? snakeIn : snakeOut) ? head : 0;
		tail = (isReversing ? snakeOut : snakeIn) ? Math.abs(tail) : 1;

		if (head === this.lastGeometryState.head &&
			tail === this.lastGeometryState.tail &&
			scale === this.lastGeometryState.scale) return;

		this.lastGeometryState.head = head;
		this.lastGeometryState.tail = tail;
		this.lastGeometryState.scale = scale;

		const path = calculateSliderProgress(this.object.path, head, tail, this.path.points);
		if (path.length === 0) return;

		this.path = path;

		const { positions, indices } = createGeometry(
			path,
			this.object.radius * (236 / 256) * scale,
			this._geometry.attributes.aPosition.buffer.data,
			this._geometry.indexBuffer.data
		);
		this._geometry.attributes.aPosition.buffer.data = positions;
		this._geometry.indexBuffer.data = indices;
	}

	spanAt(progress: number) {
		return Math.floor(progress * this.object.spans);
	}

	progressAt(progress: number) {
		const p = (progress * this.object.spans) % 1;
		if (this.spanAt(progress) % 2 === 1) return 1 - p;
		return p;
	}

	update(time: number) {
		this.ball.update(time);
		this.followCircle.update(time);
		this.followCircle.container.position = this.ball.container.position;

		for (const circle of this.drawableCircles) {
			const offset =
				circle instanceof DrawableSliderTail &&
				!(circle instanceof DrawableSliderRepeat)
					? TAIL_LENIENCY
					: 0;
			circle.update(time - offset);
		}

		const { start, end } = sharedUpdate(this, time);
		this.updateGeometry(start, end, inject<SkinManager>("skinManager")?.getCurrentSkin()?.config.General
			.Argon
			? 0.95
			: 1);

		this.judgement.frame(time);

		if (this.isHover && time > this.object.endTime + 240) this.isHover = false;
	}

	declare _evaluation?: SliderEvaluation | undefined;
	get evaluation(): SliderEvaluation | undefined {
		return this._evaluation;
	}

	set evaluation(value: SliderEvaluation | undefined) {
		this._evaluation = value;

		if (value) {
			for (let i = 0; i < this.drawableCircles.length; i++) {
				const circle = this.drawableCircles[i];
				const evaluation = value.circlesEvals[i];
				circle.evaluation = evaluation;
			}
		}

		if (!value) {
			for (const circle of this.drawableCircles) {
				circle.evaluation = undefined;
			}
		}

		this.judgement.evaluation = value;
	}

	override eval(frames: LegacyReplayFrame[]) {
		let state = false;
		const raw = [];

		const getFrameTrackingState = (frame: LegacyReplayFrame) => {
			if (!frame.mouseLeft && !frame.mouseRight) return false;
			if (
				frame.startTime < this.object.startTime ||
				frame.startTime > this.object.endTime
			)
				return false;

			const completionProgress = Clamp(
				(frame.startTime - this.object.startTime) / this.object.duration,
			);

			const position = this.object.path.curvePositionAt(
				completionProgress,
				this.object.spans,
			);

			const x = frame.position.x;
			const y = frame.position.y;
			const pointer = new Vector2(x, y);

			const radius = 64 * this.object.scale * 2.4;
			const dist = pointer.distance(
				position.add(this.object.stackedOffset).add(this.object.startPosition),
			);
			return dist <= radius && (frame.mouseLeft || frame.mouseRight);
		};

		for (const frame of frames) {
			const trackingState = getFrameTrackingState(frame);
			if (state !== trackingState) {
				raw.push(frame);
				state = trackingState;
			}
		}

		const trackingStates = [];
		for (let i = 0; i < raw.length; i += 2) {
			trackingStates.push([
				raw[i],
				raw[i + 1] ?? new LegacyReplayFrame(this.object.endTime),
			]);
		}

		const circlesEvals = this.drawableCircles.map((circle) =>
			circle.eval(frames),
		);

		const value = circlesEvals.every((e) =>
			[HitResult.LargeTickMiss, HitResult.SmallTickMiss].includes(e.value),
		)
			? HitResult.Miss
			: circlesEvals.every((e) =>
						[HitResult.LargeTickHit, HitResult.SmallTickHit].includes(e.value),
					)
				? HitResult.Great
				: circlesEvals.filter((e) =>
							[HitResult.LargeTickHit, HitResult.SmallTickHit].includes(
								e.value,
							),
						).length *
							2 >=
						this.drawableCircles.length
					? HitResult.Ok
					: HitResult.Meh;

		return {
			value,
			hitTime: trackingStates[0]?.[0]?.startTime ?? Infinity,
			circlesEvals,
			trackingStates,
		};
	}

	destroy() {
		for (const object of this.drawableCircles) {
			object.destroy();
		}

		this.ball.destroy();
		this.followCircle.destroy();

		this._geometry.destroy(true);
		this._baseGeometry.destroy(true);

		this._shader.destroy();
		this._selectShader.destroy();

		this.body.destroy(true);
		this.selectBody.destroy(true);

		this.container.destroy({ children: true });
		this.select.destroy({ children: true });

		if (this.skinEventCallback)
			this.skinManager?.removeSkinChangeListener(this.skinEventCallback);

		if (this.gameplaysEventCallback)
			inject<Gameplays>("ui/main/viewer/gameplays")?.remove(
				"change",
				this.gameplaysEventCallback,
			);
	}
}
