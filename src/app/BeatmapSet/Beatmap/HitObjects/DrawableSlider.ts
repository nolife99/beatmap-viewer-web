import { HitResult, HitSample as Sample, LegacyReplayFrame, Vector2 } from 'osu-classes';
import { type Slider, SliderHead, SliderRepeat, SliderTail, SliderTick, StandardHitObject } from 'osu-standard-stable';
import { Container, Graphics, RenderLayer } from 'pixi.js';
import Beatmap from '..';
import HitSample from '../../../Audio/HitSample.ts';
import ExperimentalConfig from '../../../Config/ExperimentalConfig.ts';
import GameplayConfig from '../../../Config/GameplayConfig.ts';
import SkinningConfig from '../../../Config/SkinningConfig.ts';
import { type Context, inject } from '../../../Context.ts';
import { refreshColor as argonRefreshColor } from '../../../Skinning/Argon/ArgonSlider.ts';
import { refreshColor as legacyRefreshColor } from '../../../Skinning/Legacy/LegacySlider.ts';
import { sharedUpdate } from '../../../Skinning/Shared/Slider.ts';
import Skin from '../../../Skinning/Skin.ts';
import SkinManager from '../../../Skinning/SkinManager.ts';
import ProgressBar from '../../../UI/main/controls/ProgressBar.ts';
import Gameplays from '../../../UI/main/viewer/Gameplay/Gameplays.ts';
import { Clamp } from '../../../utils.ts';
import BeatmapSet from '../../index.ts';
import { SliderEvaluation } from '../Replay.ts';
import TimelineSlider from '../Timeline/TimelineSlider.ts';
import DrawableHitCircle from './DrawableHitCircle.ts';
import DrawableHitObject, { type IHasApproachCircle } from './DrawableHitObject.ts';
import DrawableJudgement from './DrawableJudgement.ts';
import DrawableSliderBall from './DrawableSliderBall.ts';
import DrawableSliderFollowCircle from './DrawableSliderFollowCircle.ts';
import DrawableSliderHead from './DrawableSliderHead.ts';
import DrawableSliderRepeat from './DrawableSliderRepeat.ts';
import DrawableSliderTail, { TAIL_LENIENCY } from './DrawableSliderTail.ts';
import DrawableSliderTick from './DrawableSliderTick.ts';
import calculateSliderProgress, { type SliderProgressResult } from './Rendering/CalculateSliderProgress.ts';
import SliderBodyRenderer, { type SliderUniformPatch } from './Rendering/SliderBodyRenderer.ts';

export default class DrawableSlider
	extends DrawableHitObject
	implements IHasApproachCircle {
	public drawableCircles: DrawableHitObject[] = [];
	public select = new Container();
	path: SliderProgressResult = {
		points: [],
		length: 0
	};
	ball: DrawableSliderBall;
	followCircle: DrawableSliderFollowCircle;
	nodes: Graphics = new Graphics({ visible: false });
	container = new Container();
	timelineObject: TimelineSlider;
	wrapper = new Container();
	judgement: DrawableJudgement;
	trackColor: number[] = [0, 0, 0];
	borderColor: number[] = [0, 0, 0];
	color = '0,0,0';
	lastGeometryState = { head: Infinity, tail: -Infinity, scale: -Infinity };
	private readonly renderer = new SliderBodyRenderer();
	private sliderWhistleSample: HitSample;
	private sliderSlideSample: HitSample;
	private layer = new RenderLayer();
	private layer2 = new RenderLayer();
	private _selectionVisualsDirty = true;
	private _nodesInitialized = false;

	constructor(object: Slider) {
		super(object);
		this.object = object;
		this.context.provide<DrawableSlider>('drawable', this);

		let idx = -1;
		this.drawableCircles.push(
			...object.nestedHitObjects
				.filter((object) => object instanceof StandardHitObject)
				.map((object) => {
					if (object instanceof SliderTick) {
						return new DrawableSliderTick(
							object,
							this.object,
							this.object.samples.find(
								(sample) => sample.hitSound === 'Normal'
							)!
						).hook(this.context);
					}

					idx++;

					if (object instanceof SliderRepeat) {
						return new DrawableSliderRepeat(
							object,
							this.object,
							this.object.nodeSamples[idx]
						).hook(this.context);
					}

					if (object instanceof SliderTail) {
						return new DrawableSliderTail(
							object,
							this.object,
							this.object.nodeSamples[idx]
						).hook(this.context);
					}

					if (object instanceof SliderHead) {
						return new DrawableSliderHead(
							object,
							this.object,
							this.object.nodeSamples[idx]
						).hook(this.context);
					}

					return null;
				})
				.filter((object) => object !== null)
		);

		this.context.provide('slider', this);

		this.ball = new DrawableSliderBall(this.object).hook(this.context);
		this.followCircle = new DrawableSliderFollowCircle(this.object).hook(this.context);

		this.wrapper.addChild(
			this.renderer.body,
			...this.drawableCircles
				.slice(1)
				.toReversed()
				.map((circle) => circle.container),
			this.followCircle.container,
			this.ball.container,
			this.drawableCircles[0].container,
			this.layer,
			this.layer2
		);

		const judgementLayer = new RenderLayer();
		this.container.addChild(judgementLayer, this.wrapper);

		this.select.addChild(this.renderer.selectionBody);

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
		whistleSample.hitSound = 'sliderwhistle';
		this.sliderWhistleSample = new HitSample([whistleSample]).hook(this.context);

		const slideSample = new Sample();
		slideSample.hitSound = 'sliderslide';
		this.sliderSlideSample = new HitSample([slideSample]).hook(this.context);

		this.refreshSprite();
		this.skinEventCallback = this.skinManager?.addSkinChangeListener(() =>
			this.refreshSprite()
		);
		this.gameplaysEventCallback = inject<Gameplays>(
			'ui/main/viewer/gameplays'
		)?.on('change', () => this.refreshColor());
		inject<ExperimentalConfig>('config/experimental')?.onChange(
			'overlapGameplays',
			() => this.refreshColor()
		);

		this.updateRenderUniforms({
			scale: (object.radius / 54.4) * (236 / 256)
		});

		this.timelineObject = new TimelineSlider(object).hook(this.context);

		this.judgement = new DrawableJudgement(this);
		judgementLayer.attach(this.judgement.container);
		this.container.addChild(this.judgement.container);
		this.judgement.container.position.x = object.endPosition.add(
			object.stackedOffset
		).x;
		this.judgement.container.position.y = object.endPosition.add(
			object.stackedOffset
		).y;
		this.judgement.container.scale.set(object.scale);
	}

	public get bodyAlpha() {
		return this.renderer.alphaFilter.alpha;
	}

	public set bodyAlpha(val: number) {
		this.renderer.alphaFilter.alpha = val;
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
		if (val) this.updateSelectionVisualsIfNeeded();

		for (const circle of this.drawableCircles) {
			if (
				circle instanceof DrawableSliderHead ||
				circle instanceof DrawableSliderTail ||
				circle instanceof DrawableSliderRepeat
			) {
				circle.select.visible = val;
			}
		}
	}

	private _object!: Slider;

	get object() {
		return this._object;
	}

	set object(val: Slider) {
		this._object = val;

		const x = val.startPosition.x + val.stackedOffset.x;
		const y = val.startPosition.y + val.stackedOffset.y;

		this.renderer.setPosition(x, y);

		this.nodes.x = x;
		this.nodes.y = y;

		const nodes = val.nestedHitObjects.filter(
			(object) => object instanceof StandardHitObject
		);

		let idx = -1;
		for (let i = 0; i < this.drawableCircles.length; i++) {
			const circle = this.drawableCircles[i];
			circle.object = val;

			if (circle instanceof DrawableSliderTick) {
				circle.updateObjects(
					nodes[i] as SliderTick,
					val,
					val.samples.find((sample) => sample.hitSound === 'Normal')!
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
				val.stackedOffset
			).x;
			this.judgement.container.position.y = val.endPosition.add(
				val.stackedOffset
			).y;
			this.judgement.container.scale.set(val.scale);
		}

		this._selectionVisualsDirty = true;
		if (this.isSelected) {
			this.updateSelectionVisualsIfNeeded();
		}

		this.lastGeometryState = { head: Infinity, tail: -Infinity, scale: -Infinity };
	}

	get approachCircle() {
		return (this.drawableCircles[0] as DrawableHitCircle).approachCircle;
	}

	declare _evaluation?: SliderEvaluation | undefined;
	override get evaluation(): SliderEvaluation | undefined {
		return this._evaluation;
	}

	override set evaluation(value: SliderEvaluation | undefined) {
		this._evaluation = value;

		if (value) {
			for (let i = 0; i < this.drawableCircles.length; i++) {
				const circle = this.drawableCircles[i];
				circle.evaluation = value.circlesEvals[i];
			}
		}

		if (!value) {
			for (const circle of this.drawableCircles) {
				circle.evaluation = undefined;
			}
		}

		this.judgement.evaluation = value;
	}

	updateRenderUniforms(patch: SliderUniformPatch, includeSelection = true) {
		this.renderer.setUniforms(patch, includeSelection);
	}

	updateBodyUniforms(patch: SliderUniformPatch) {
		this.renderer.setBodyUniforms(patch);
	}

	updateSelectionUniforms(patch: SliderUniformPatch) {
		this.renderer.setSelectionUniforms(patch);
	}

	checkCollide(rect: [Vector2, Vector2], time: number) {
		const obj = this._object;

		if (time < obj.startTime - obj.timePreempt || time > obj.endTime + 240) {
			return false;
		}

		if (!this.wrapper.visible) return false;

		const a = rect[0];
		const b = rect[1];

		let minX = a.x;
		let maxX = b.x;
		if (minX > maxX) {
			const t = minX;
			minX = maxX;
			maxX = t;
		}

		let minY = a.y;
		let maxY = b.y;
		if (minY > maxY) {
			const t = minY;
			minY = maxY;
			maxY = t;
		}

		const radius = 48 * obj.scale;
		const radiusSq = radius * radius;

		const objX = obj.startX + obj.stackedOffset.x;
		const objY = obj.startY + obj.stackedOffset.y;

		const pathPts = this.path.points;
		const pathLength = this.path.length;

		let p1, p2, x1, y1, x2, y2;
		let segMinX, segMaxX, segMinY, segMaxY;
		let abx, aby, cdx, cdy, denom, acx, acy, tInt, uInt;
		let lenSq, tDist, ox, oy;

		for (let i = 0; i < pathLength - 1; i++) {
			p1 = pathPts[i];
			p2 = pathPts[i + 1];

			x1 = p1.x + objX;
			y1 = p1.y + objY;
			x2 = p2.x + objX;
			y2 = p2.y + objY;

			// AABB vs Capsule Bounding Box fast reject
			segMinX = x1 < x2 ? x1 : x2;
			segMaxX = x1 > x2 ? x1 : x2;
			segMinY = y1 < y2 ? y1 : y2;
			segMaxY = y1 > y2 ? y1 : y2;

			if (
				segMaxX + radius < minX ||
				segMinX - radius > maxX ||
				segMaxY + radius < minY ||
				segMinY - radius > maxY
			) {
				continue;
			}

			// Point in Rect check for segment endpoints
			if ((x1 >= minX && x1 <= maxX && y1 >= minY && y1 <= maxY) ||
				(x2 >= minX && x2 <= maxX && y2 >= minY && y2 <= maxY)) {
				return true;
			}

			// Segment vector
			abx = x2 - x1;
			aby = y2 - y1;

			// Segment intersections with Rect Edges

			// Edge 1: Top (minX, minY) to (maxX, minY)
			cdx = maxX - minX; cdy = 0;
			denom = abx * cdy - aby * cdx;
			if (denom !== 0) {
				acx = minX - x1; acy = minY - y1;
				tInt = (acx * cdy - acy * cdx) / denom;
				if (tInt >= 0 && tInt <= 1) {
					uInt = (acx * aby - acy * abx) / denom;
					if (uInt >= 0 && uInt <= 1) return true;
				}
			}

			// Edge 2: Bottom (maxX, minY) to (maxX, maxY)
			cdx = 0; cdy = maxY - minY;
			denom = abx * cdy - aby * cdx;
			if (denom !== 0) {
				acx = maxX - x1; acy = minY - y1;
				tInt = (acx * cdy - acy * cdx) / denom;
				if (tInt >= 0 && tInt <= 1) {
					uInt = (acx * aby - acy * abx) / denom;
					if (uInt >= 0 && uInt <= 1) return true;
				}
			}

			// Edge 3: Right (maxX, maxY) to (minX, maxY)
			cdx = minX - maxX; cdy = 0;
			denom = abx * cdy - aby * cdx;
			if (denom !== 0) {
				acx = maxX - x1; acy = maxY - y1;
				tInt = (acx * cdy - acy * cdx) / denom;
				if (tInt >= 0 && tInt <= 1) {
					uInt = (acx * aby - acy * abx) / denom;
					if (uInt >= 0 && uInt <= 1) return true;
				}
			}

			// Edge 4: Left (minX, maxY) to (minX, minY)
			cdx = 0; cdy = minY - maxY;
			denom = abx * cdy - aby * cdx;
			if (denom !== 0) {
				acx = minX - x1; acy = maxY - y1;
				tInt = (acx * cdy - acy * cdx) / denom;
				if (tInt >= 0 && tInt <= 1) {
					uInt = (acx * aby - acy * abx) / denom;
					if (uInt >= 0 && uInt <= 1) return true;
				}
			}

			// Point Segment Distance Sq for Rect Corners
			lenSq = abx * abx + aby * aby;

			if (lenSq <= 0) {
				// Corner 1 (minX, minY)
				ox = minX - x1; oy = minY - y1;
				if (ox * ox + oy * oy <= radiusSq) return true;
				// Corner 2 (maxX, minY)
				ox = maxX - x1; oy = minY - y1;
				if (ox * ox + oy * oy <= radiusSq) return true;
				// Corner 3 (maxX, maxY)
				ox = maxX - x1; oy = maxY - y1;
				if (ox * ox + oy * oy <= radiusSq) return true;
				// Corner 4 (minX, maxY)
				ox = minX - x1; oy = maxY - y1;
				if (ox * ox + oy * oy <= radiusSq) return true;
			} else {
				// Corner 1: (minX, minY)
				tDist = ((minX - x1) * abx + (minY - y1) * aby) / lenSq;
				if (tDist < 0) tDist = 0; else if (tDist > 1) tDist = 1;
				ox = minX - (x1 + tDist * abx); oy = minY - (y1 + tDist * aby);
				if (ox * ox + oy * oy <= radiusSq) return true;

				// Corner 2: (maxX, minY)
				tDist = ((maxX - x1) * abx + (minY - y1) * aby) / lenSq;
				if (tDist < 0) tDist = 0; else if (tDist > 1) tDist = 1;
				ox = maxX - (x1 + tDist * abx); oy = minY - (y1 + tDist * aby);
				if (ox * ox + oy * oy <= radiusSq) return true;

				// Corner 3: (maxX, maxY)
				tDist = ((maxX - x1) * abx + (maxY - y1) * aby) / lenSq;
				if (tDist < 0) tDist = 0; else if (tDist > 1) tDist = 1;
				ox = maxX - (x1 + tDist * abx); oy = maxY - (y1 + tDist * aby);
				if (ox * ox + oy * oy <= radiusSq) return true;

				// Corner 4: (minX, maxY)
				tDist = ((minX - x1) * abx + (maxY - y1) * aby) / lenSq;
				if (tDist < 0) tDist = 0; else if (tDist > 1) tDist = 1;
				ox = minX - (x1 + tDist * abx); oy = maxY - (y1 + tDist * aby);
				if (ox * ox + oy * oy <= radiusSq) return true;
			}
		}

		return false;
	}

	override hook(context: Context) {
		super.hook(context);

		for (const object of this.drawableCircles.filter(
			(object) =>
				object instanceof DrawableSliderHead ||
				object instanceof DrawableSliderTail ||
				object instanceof DrawableSliderRepeat ||
				object instanceof DrawableSliderTick
		)) {
			object.refreshSprite();
		}
		this.ball.refreshSprite();
		this.followCircle.refreshSprite();
		this.refreshSprite();
		this.timelineObject.updateVelocity();

		return this;
	}

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

		this._selectionVisualsDirty = true;
		if (this.isSelected) {
			this.updateSelectionVisualsIfNeeded();
		}
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
		const beatmap = this.context.consume<Beatmap>('beatmapObject');
		if (
			beatmap?.data?.colors.comboColors.length &&
			!inject<SkinningConfig>('config/skinning')?.disableBeatmapSkin
		) {
			const colors = beatmap.data.colors.comboColors;
			const comboIndex = this.object.comboIndexWithOffsets % colors.length;

			return `rgb(${colors[comboIndex].red},${colors[comboIndex].green},${colors[comboIndex].blue})`;
		}

		const comboIndex = this.object.comboIndexWithOffsets % skin.colorsLength;
		const key = `Combo${comboIndex + 1}` as keyof typeof skin.config.Colours;
		const color = skin.config.Colours[key] ?? skin.config.Colours.Combo1;

		return `rgb(${color})`;
	}

	getTimeRange() {
		return {
			start: this.object.startTime - this.object.timePreempt,
			end: this.object.endTime + 800
		};
	}

	override playHitSound(time: number): void {
		const beatmap = this.context.consume<Beatmap>('beatmapObject');
		const isSeeking =
			inject<ProgressBar>('ui/main/controls/progress')?.isSeeking ||
			inject<BeatmapSet>('beatmapset')?.isSeeking;
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
			this.object.startTime
		);

		if (this.object.hitSound !== 0) {
			this.sliderWhistleSample.playLoop(
				currentSamplePoint,
				time,
				this.object.startTime,
				this.object.endTime
			);
		}

		this.sliderSlideSample.playLoop(
			currentSamplePoint,
			time,
			this.object.startTime,
			this.object.endTime
		);
	}

	updateGeometry(progressHead = 0, progressTail = 0, scale = 1) {
		const snakeIn = inject<GameplayConfig>('config/gameplay')?.snakeInSlider;
		const snakeOut = inject<GameplayConfig>('config/gameplay')?.snakeOutSlider;

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

		if (
			head === this.lastGeometryState.head &&
			tail === this.lastGeometryState.tail &&
			scale === this.lastGeometryState.scale
		) {
			return;
		}

		this.lastGeometryState.head = head;
		this.lastGeometryState.tail = tail;
		this.lastGeometryState.scale = scale;

		const path = calculateSliderProgress(this.object.path, head, tail, this.path.points);
		if (path.length === 0) return;

		this.path = path;
		this.renderer.updateMainGeometry(path, this.object.radius * (236 / 256) * scale);
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

		const updated = sharedUpdate(this, time);
		if (updated) this.updateGeometry(updated.start, updated.end, this.getSkinBodyScale());

		this.judgement.frame(time);

		if (this.isHover && time > this.object.endTime + 240) this.isHover = false;
	}

	override eval(frames: LegacyReplayFrame[]) {
		let state = false;
		const raw = [];

		const getFrameTrackingState = (frame: LegacyReplayFrame) => {
			if (!frame.mouseLeft && !frame.mouseRight) return false;
			if (
				frame.startTime < this.object.startTime ||
				frame.startTime > this.object.endTime
			) {
				return false;
			}

			const completionProgress = Clamp(
				(frame.startTime - this.object.startTime) / this.object.duration
			);

			const position = this.object.path.curvePositionAt(
				completionProgress,
				this.object.spans
			);

			const x = frame.position.x;
			const y = frame.position.y;

			const px =
				position.x +
				this.object.stackedOffset.x +
				this.object.startPosition.x;

			const py =
				position.y +
				this.object.stackedOffset.y +
				this.object.startPosition.y;

			const dx = x - px;
			const dy = y - py;

			const radius = 64 * this.object.scale * 2.4;
			return dx * dx + dy * dy <= radius * radius;
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
				raw[i + 1] ?? new LegacyReplayFrame(this.object.endTime)
			]);
		}

		const circlesEvals = this.drawableCircles.map((circle) =>
			circle.eval(frames)
		);

		const value = circlesEvals.every((e) =>
			[HitResult.LargeTickMiss, HitResult.SmallTickMiss].includes(e.value)
		)
			? HitResult.Miss
			: circlesEvals.every((e) =>
				[HitResult.LargeTickHit, HitResult.SmallTickHit].includes(e.value)
			)
				? HitResult.Great
				: circlesEvals.filter((e) =>
					[HitResult.LargeTickHit, HitResult.SmallTickHit].includes(e.value)
				).length * 2 >=
				this.drawableCircles.length
					? HitResult.Ok
					: HitResult.Meh;

		return {
			value,
			hitTime: trackingStates[0]?.[0]?.startTime ?? Infinity,
			circlesEvals,
			trackingStates
		};
	}

	destroy() {
		for (const object of this.drawableCircles) {
			object.destroy();
		}

		this.ball.destroy();
		this.followCircle.destroy();

		this.renderer.destroy();

		this.container.destroy({ children: true });
		this.select.destroy({ children: true });

		if (this.skinEventCallback) {
			this.skinManager?.removeSkinChangeListener(this.skinEventCallback);
		}

		if (this.gameplaysEventCallback) {
			inject<Gameplays>('ui/main/viewer/gameplays')?.remove(
				'change',
				this.gameplaysEventCallback
			);
		}
	}

	private getSkinBodyScale() {
		return inject<SkinManager>('skinManager')?.getCurrentSkin()?.config.General.Argon
			? 0.95
			: 1;
	}

	private updateSelectionVisualsIfNeeded() {
		const val = this._object;
		if (!this._selectionVisualsDirty || !val) return;

		if (!this._nodesInitialized) {
			this._nodesInitialized = true;

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
		}

		const selectionScale = this.getSkinBodyScale();
		const selectionRadius = val.radius * (236 / 256) * selectionScale;
		this.renderer.updateSelectionGeometry({
			points: this.object.path.calculatedPath,
			length: this.object.path.calculatedPath.length
		}, selectionRadius);

		this._selectionVisualsDirty = false;
	}
}