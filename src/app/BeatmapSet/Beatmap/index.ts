import extraMode from '../../../assets/extra-mode.svg?raw';
import { sort } from 'fast-sort';
import crypto from 'node:crypto';
import { ControlPoint, ControlPointType, Vector2 } from 'osu-classes';
import { BeatmapDecoder } from 'osu-parsers';
import {
	Circle,
	Slider,
	Spinner,
	type StandardBeatmap,
	type StandardDifficultyAttributes,
	type StandardDifficultyCalculator,
	StandardDifficultyHitObject,
	StandardRuleset,
	type StandardStrainSkill
} from 'osu-standard-stable';
import { Color, type ColorSource } from 'pixi.js';
import BeatmapSet from '..';
import Audio from '../../Audio/index.ts';
import BackgroundConfig from '../../Config/BackgroundConfig.ts';
import ExperimentalConfig from '../../Config/ExperimentalConfig.ts';
import { inject, ScopedClass } from '../../Context.ts';
import ProgressBar from '../../UI/main/controls/ProgressBar.ts';
import Gameplays from '../../UI/main/viewer/Gameplay/Gameplays.ts';
import Gameplay from '../../UI/main/viewer/Gameplay/index.ts';
import Timeline from '../../UI/main/viewer/Timeline/index.ts';
import { StrainPoint } from '../../UI/sidepanel/Modding/DifficultyGraph.ts';
import Timing from '../../UI/sidepanel/Timing/index.ts';
import { difficultyRange, getDiffColour } from '../../utils.ts';
import DrawableFollowPoints from './HitObjects/DrawableFollowPoints.ts';
import DrawableHitCircle from './HitObjects/DrawableHitCircle.ts';
import DrawableHitObject, { IHasApproachCircle } from './HitObjects/DrawableHitObject.ts';
import DrawableSlider from './HitObjects/DrawableSlider.ts';
import DrawableSpinner from './HitObjects/DrawableSpinner.ts';
import BeatmapSliderLayer from './HitObjects/Rendering/BeatmapSliderLayer.ts';
import Replay from './Replay.ts';

// @ts-expect-error: Deno LSP struggles with Vite's ?worker suffix
import ObjectsWorker from './Worker/Objects.ts?worker&inline';

const decoder = new BeatmapDecoder();
const ruleset = new StandardRuleset();

export default class Beatmap extends ScopedClass {
	data: StandardBeatmap;
	difficultyAttributes: StandardDifficultyAttributes;

	objects: DrawableHitObject[] = [];
	connectors: DrawableFollowPoints[] = [];

	color: ColorSource;
	randomColor: ColorSource = new Color(Math.floor(Math.random() * 0xffffff))
		.toHex();

	worker: Worker = new ObjectsWorker;
	previousObjects = new Set<number>();
	previousTime = 0;
	container: Gameplay;
	sliderRenderLayer?: BeatmapSliderLayer;
	md5: string;
	// Taken from https://github.com/Rian8337/osu-droid-module/blob/master/packages/osu-strain-graph-generator/src/index.ts
	strains: StrainPoint[] = [];
	replay?: Replay;

	private loaded = false;
	private previousConnectors = new Set<number>();
	private workerUpdate: ((this: Worker, ev: MessageEvent) => void) | null =
		null;

	constructor(public raw: ArrayBuffer, public beatmapSet: BeatmapSet) {
		super();

		this.md5 = crypto.createHash('md5').update(new Uint8Array(raw)).digest('hex');

		const initialMods =
			inject<ExperimentalConfig>('config/experimental')?.getModsString() ?? '';

		const base = decoder.decodeFromBuffer(raw);
		this.data = ruleset.applyToBeatmapWithMods(
			base,
			ruleset.createModCombination(initialMods)
		);

		const calculator = ruleset.createDifficultyCalculator(this.data);
		this.difficultyAttributes = calculator.calculateWithMods(
			ruleset.createModCombination(initialMods)
		);
		this.calculateStrainGraph(initialMods, calculator);

		this.color = getDiffColour(this.difficultyAttributes.starRating);
		this.container = new Gameplay(this);

		this.worker.postMessage({
			type: 'preempt',
			preempt: difficultyRange(
				this.data.difficulty.approachRate,
				1800,
				1200,
				450
			)
		});

		this.lifetime.use(inject<ExperimentalConfig>('config/experimental')?.onChange(
			'mods',
			({
				 mods: val,
				 shouldRecalculate
			 }: {
				mods: string;
				shouldRecalculate: boolean;
			}) => {
				const appliedMods = ruleset.applyToBeatmapWithMods(
					base,
					ruleset.createModCombination(val)
				);

				if (shouldRecalculate) {
					this.data = appliedMods;
					this.reassignObjects();
					this.replay?.evaluate(this);
				}

				const calculator = ruleset.createDifficultyCalculator(
					appliedMods
				);
				this.difficultyAttributes = calculator.calculateWithMods(
					ruleset.createModCombination(val)
				);
				this.calculateStrainGraph(val, calculator);

				this.recalculateDifficulty();
			}
		));

		this.lifetime.use(() => {
			this.reset();
			this.container.destroy();
			this.worker.terminate();
		});
	}

	load() {
		this.loaded = true;

		if (this.replay) {
			this.hookReplay(this.replay);
		}
	}

	async loadTimingPoints() {
		const audio = this.context.consume<Audio>('audio');

		const points = this.data.controlPoints.groups.map((group) => {
			const hasTimingPoint = group.controlPoints.some(
				(point) => point.pointType === ControlPointType.TimingPoint
			);
			const hasDifficultyPoint = group.controlPoints.some(
				(point) => point.pointType === ControlPointType.DifficultyPoint
			);
			const hasSamplePoint = group.controlPoints.some(
				(point) => point.pointType === ControlPointType.SamplePoint
			);

			if (!hasTimingPoint && !hasDifficultyPoint && hasSamplePoint) {
				return null;
			}

			return {
				position: group.startTime / (audio?.duration ?? 1),
				color: hasTimingPoint && !hasDifficultyPoint
					? 0xff1749
					: hasTimingPoint && hasDifficultyPoint
						? 0xff9717
						: 0x17ff51
			};
		});

		const kiaiSections: {
			start: number;
			end: number;
		}[] = [];
		const effectPoints = this.data.controlPoints.effectPoints;

		const buffer = [];
		let isKiai = false;

		for (let i = 0; i < effectPoints.length; i++) {
			if (effectPoints[i].kiai && !isKiai) {
				isKiai = true;
				buffer.push(effectPoints[i].startTime / (audio?.duration ?? 1));

				continue;
			}

			if (!effectPoints[i].kiai && isKiai) {
				isKiai = false;
				buffer.push(effectPoints[i].startTime / (audio?.duration ?? 1));

				kiaiSections.push({
					start: buffer[0],
					end: buffer.at(-1) ?? 1
				});

				buffer.length = 0;
			}
		}

		const breaks: {
			start: number;
			end: number;
		}[] = this.data.events.breaks.map(({ startTime, endTime }) => ({
			start: startTime / (audio?.duration ?? 1),
			end: endTime / (audio?.duration ?? 1)
		}));

		const timingPoints = [
			...this.data.controlPoints.timingPoints,
			...this.data.controlPoints.difficultyPoints,
			...this.data.controlPoints.samplePoints
		].sort((a, b) => {
			if (a.startTime === b.startTime) {
				const getPointRank = (
					t: ControlPoint
				) => {
					if (t.pointType === ControlPointType.TimingPoint) return 0;
					if (t.pointType === ControlPointType.DifficultyPoint) return 1;
					if (t.pointType === ControlPointType.SamplePoint) return 2;
					return 0;
				};

				return getPointRank(a) - getPointRank(b);
			}

			return a.startTime - b.startTime;
		});

		await inject<Timing>('ui/sidepanel/timing')?.updateTimingPoints(
			timingPoints
		);
		inject<Timeline>('ui/main/viewer/timeline')?.loadTimingPoints(
			this.data.controlPoints.timingPoints
		);
		inject<ProgressBar>('ui/main/controls/progress')?.drawTimeline(
			points,
			kiaiSections,
			breaks
		);
	}

	async loadHitObjects() {
		this.context.provide('beatmapObject', this);

		console.time('Constructing hitObjects');

		this.sliderRenderLayer = new BeatmapSliderLayer();
		this.container.objectsContainer.addChildAt(this.sliderRenderLayer, 0);

		const async = inject<ExperimentalConfig>(
			'config/experimental'
		)?.asyncLoading;

		if (async) await this.loadHitObjectsAsync(this.sliderRenderLayer);
		else this.loadHitObjectsSync(this.sliderRenderLayer);

		this.connectors = (await this.constructConnectors()).filter(
			(conn) => conn !== null
		);
		console.timeEnd('Constructing hitObjects');

		this.worker.postMessage({
			type: 'init',
			objects: this.data.hitObjects
				.map((object) => {
					return {
						startTime: object.startTime,
						endTime: (object as Slider).endTime
					};
				})
				.filter((object) => object !== null),
			connectors: this.connectors.map((connector) => {
				return {
					startTime: connector.startTime,
					endTime: connector.endTime
				};
			})
		});

		this.postAudioClockToWorker();

		this.worker.addEventListener(
			'message',
			this.workerUpdate = (event) => {
				switch (event.data.type) {
					case 'update': {
						const { objects, connectors, currentTime, previousTime } = event.data;

						const currentInBreak = this.data.events.breaks.some(
							({ startTime, endTime }) =>
								startTime <= currentTime && currentTime <= endTime
						);

						const currentInMap = currentTime >
							this.data.hitObjects[0].startTime -
							this.data.hitObjects[0].timePreempt &&
							currentTime <
							((this.data.hitObjects.at(-1) as Slider).endTime ??
								this.data.hitObjects.at(-1)?.startTime);

						const backgroundConfig = inject<BackgroundConfig>(
							'config/background'
						);

						if (backgroundConfig) {
							const shouldBreak = !(!currentInBreak && currentInMap);

							if (backgroundConfig.breakSection !== shouldBreak) {
								backgroundConfig.breakSection = shouldBreak;
							}
						}

						this.previousTime = previousTime;
						this.update(currentTime, objects, connectors);

						break;
					}
				}
			}
		);

		const audio = this.context.consume<Audio>('audio');

		this.worker.postMessage({
			type: 'playbackRate',
			playbackRate:
				this.beatmapSet.playbackRate ?? 1
		});

		this.seek(audio?.currentTime ?? 0);

		if (audio?.state === 'PLAYING') {
			this.worker.postMessage({ type: 'start' });
		}

		if (audio?.state === 'STOPPED') {
			this.worker.postMessage({ type: 'stop' });
		}
	}

	frame(time: number) {
		this.updateSelectorAndDragSelection();

		const containers = [];
		const approachCircleContainers = [];
		const connectorContainers = [];

		const objs = sort([...this.previousObjects]).desc(
			(u) => this.objects[u].object.startTime
		);

		for (const idx of objs) {
			const obj = this.objects[idx];
			if (!obj.container.visible) continue;

			containers.push(obj.container);

			const approachCircle =
				(obj as unknown as IHasApproachCircle).approachCircle;
			if (approachCircle) {
				approachCircleContainers.push(approachCircle.container);
			}
		}

		for (const idx of this.previousConnectors) {
			connectorContainers.push(this.connectors[idx].container);
			this.connectors[idx].update(time);
		}

		const totalChildren = connectorContainers.length +
			containers.length +
			approachCircleContainers.length;

		if (totalChildren > 0) {
			this.container.objectsContainer?.addChild(
				...connectorContainers,
				...containers,
				...approachCircleContainers
			);
		}

		for (const idx of objs) {
			this.objects[idx].update(time);
		}

		this.replay?.frame(time);
	}

	getNearestSamplePoint(time: number) {
		const currentSamplePoint = this.data.controlPoints.samplePointAt(
			Math.ceil(time)
		);

		const potentialFutureSamplePoint = this.data.controlPoints.samplePointAt(
			Math.ceil(time + 2)
		);

		let samplePoint = currentSamplePoint;
		if (
			potentialFutureSamplePoint?.group &&
			potentialFutureSamplePoint.group.startTime - time < 3
		) {
			samplePoint = potentialFutureSamplePoint;
		}

		return samplePoint;
	}

	update(
		time: number,
		objects: Set<number>,
		connectors: Set<number>
	) {
		if (!this.loaded) return;

		const objectsWithSelected = objects.union(this.container.selected);
		const objectContainer = this.container.objectsContainer;

		const disposedObjects = this.previousObjects.difference(
			objectsWithSelected
		);
		const disposedConnectors = this.previousConnectors.difference(connectors);

		this.previousObjects = objectsWithSelected;
		this.previousConnectors = connectors;

		for (const idx of disposedObjects) {
			objectContainer?.removeChild(this.objects[idx].container);
			if ((this.objects[idx] as unknown as IHasApproachCircle).approachCircle) {
				objectContainer?.removeChild(
					(this.objects[idx] as unknown as IHasApproachCircle).approachCircle
						.container
				);
			}
		}

		for (const idx of disposedConnectors) {
			objectContainer?.removeChild(this.connectors[idx].container);
		}

		for (const idx of objects) {
			this.objects[idx]?.playHitSound(time);
		}
	}

	onPlaybackRateChange(rate: number) {
		this.worker.postMessage({ type: 'playbackRate', playbackRate: rate });
	}

	toggle() {
		if (!this.loaded) {
			throw new Error(
				'Cannot play / pause a beatmap that hasn\'t been initialized'
			);
		}

		this.postAudioClockToWorker();

		const audio = this.context.consume<Audio>('audio');

		if (audio?.state === 'PLAYING') {
			this.worker.postMessage({ type: 'start' });
		}

		if (audio?.state === 'STOPPED') {
			this.worker.postMessage({ type: 'stop' });
		}
	}

	seek(time: number) {
		if (!this.loaded) {
			throw new Error(
				'Cannot play / pause a beatmap that hasn\'t been initialized'
			);
		}

		this.postAudioClockToWorker();
		this.worker.postMessage({ type: 'seek', time });
	}

	hookReplay(replay: Replay) {
		this.unhookReplay();

		const mods = ruleset.createModCombination(replay?.data?.info.rawMods);
		const config = inject<ExperimentalConfig>('config/experimental');

		let hasModChange = false;
		if (config) {
			if (config.hardRock !== mods.acronyms.includes('HR')) {
				hasModChange = true;
				config.hardRock = mods.acronyms.includes('HR') ?? false;
			}

			if (config.doubleTime !== mods.acronyms.includes('DT')) {
				hasModChange = true;
				config.doubleTime = mods.acronyms.includes('DT') ?? false;
			}

			if (config.hidden !== mods.acronyms.includes('HD')) {
				config.hidden = mods.acronyms.includes('HD') ?? false;
			}
		}

		this.container.cursorLayer.addChild(
			...replay.trails.toReversed(),
			replay.cursor
		);
		this.replay = replay;

		if (!hasModChange) this.replay?.evaluate(this);
	}

	unhookReplay() {
		if (this.replay) this.container.cursorLayer.removeChildren();
		this.replay = undefined;
		for (const object of this.objects) {
			object.evaluation = undefined;
		}
	}

	reset() {
		inject<Gameplays>('ui/main/viewer/gameplays')?.removeGameplay(
			this.container
		);

		if (this.workerUpdate) {
			this.worker.postMessage({ type: 'stop' });
			this.worker.removeEventListener('message', this.workerUpdate);
		}
		this.loaded = false;

		this.container.objectsContainer.removeChildren();

		for (const object of this.objects) {
			object.destroy();
			(object as DrawableHitCircle | DrawableSlider).timelineObject?.destroy();
		}

		this.sliderRenderLayer?.destroy();

		for (const connector of this.connectors) {
			connector.destroy();
		}

		this.objects = [];
		this.connectors = [];

		this.previousConnectors.clear();
		this.previousObjects.clear();
	}

	private updateSelectorAndDragSelection() {
		const [globalA, globalB] = this.container.dragWindow;

		if (globalA.distance(globalB) <= 0) {
			this.container.selector.scale.set(0, 0);
			return;
		}

		const localA = this.container.wrapper.toLocal(globalA);
		const localB = this.container.wrapper.toLocal(globalB);

		const x = Math.min(localA.x, localB.x);
		const y = Math.min(localA.y, localB.y);
		const w = Math.abs(localB.x - localA.x);
		const h = Math.abs(localB.y - localA.y);

		this.container.selector.position.set(x, y);
		this.container.selector.scale.set(w, h);

		const rect: [Vector2, Vector2] = [
			this.container.objectsContainer.toLocal(this.container.dragWindow[0]),
			this.container.objectsContainer.toLocal(this.container.dragWindow[1])
		];

		for (const idx of this.previousObjects) {
			const obj = this.objects[idx];

			if (
				(obj instanceof DrawableHitCircle || obj instanceof DrawableSlider) &&
				obj.checkCollide(rect)
			) {
				this.container.addSelected(idx);
			}
		}
	}

	private postAudioClockToWorker(): void {
		const audio = this.context.consume<Audio>('audio');
		if (!audio) return;

		this.worker.postMessage({
			type: 'clock',
			sabClock: audio.encodedClock
		});
	}

	private calculateStrainGraph(mods: string, calculator: StandardDifficultyCalculator) {
		const modsCombination = ruleset.createModCombination(mods);
		const beatmap: StandardBeatmap = calculator
			['_getWorkingBeatmap'](modsCombination);

		if (!beatmap.hitObjects.length) return;

		const sectionLength = 400;
		const currentSectionEnd =
			Math.ceil(beatmap.hitObjects[0].startTime / sectionLength) *
			sectionLength;

		const skills: StandardStrainSkill[] = calculator[
			'_createSkills'
			](beatmap, modsCombination).filter(
			(skill): skill is StandardStrainSkill => 'difficultyValue' in skill
		);

		const aimStrainPeaks = skills[1]['_strainPeaks'];
		const speedStrainPeaks = skills[1]['_strainPeaks'];

		const objs: StandardDifficultyHitObject[] = calculator
			['_getDifficultyHitObjects'](beatmap, 1);

		for (const hitObject of objs) {
			for (const skill of skills) {
				skill.process(hitObject);
			}
		}

		const strainInformations: {
			time: number;
			strain: number;
		}[] = new Array(
			Math.max(aimStrainPeaks.length, speedStrainPeaks.length) + 1
		);

		strainInformations[0] = {
			strain: 0,
			time: (currentSectionEnd - sectionLength) / 1000
		};

		for (let i = 1; i < strainInformations.length; ++i) {
			const aimStrain = aimStrainPeaks[i] ?? 0;
			const speedStrain = speedStrainPeaks[i] ?? 0;

			strainInformations[i] = {
				time: (currentSectionEnd + sectionLength * (i - 1)) / 1000,
				strain: (aimStrain + speedStrain) / 2
			};
		}

		this.strains = strainInformations;
	}

	private reassignObjects() {
		this.worker.postMessage({
			type: 'preempt',
			preempt: difficultyRange(
				this.data.difficulty.approachRate,
				1800,
				1200,
				450
			)
		});

		const objs = this.data.hitObjects.filter(
			(object) =>
				object instanceof Circle ||
				object instanceof Slider ||
				object instanceof Spinner
		);
		for (let i = 0; i < this.objects.length; i++) {
			this.objects[i].object = objs[i];
		}

		let j = 0;
		for (let i = 0; i < this.data.hitObjects.length - 1; i++) {
			const startObject = this.data.hitObjects[i];
			const endObject = this.data.hitObjects[i + 1];
			if (endObject.isNewCombo) continue;

			this.connectors[j]?.updateObjects(startObject, endObject);
			j++;
		}

		if (this.context.consume<Audio>('audio')?.state === 'STOPPED') {
			this.worker.postMessage({
				type: 'stop'
			});
		}
	}

	private recalculateDifficulty() {
		if (this.beatmapSet.master !== this) return;

		this.color = getDiffColour(this.difficultyAttributes.starRating);
		const el = document.querySelector<HTMLSpanElement>('#masterDiff');
		if (el) {
			el.innerHTML = `
						<span class="truncate">${this.data.metadata.version}</span>
						<br/>
						<span class="text-xs">
							CS <span class="font-medium">${
				this.data.difficulty.circleSize.toFixed(1).replace('.0', '')
			}</span> /
							AR <span class="font-medium">${
				this.difficultyAttributes.approachRate.toFixed(1).replace('.0', '')
			}</span> /
							OD <span class="font-medium">${
				this.difficultyAttributes.overallDifficulty.toFixed(1).replace('.0', '')
			}</span> /
							HP <span class="font-medium">${
				this.difficultyAttributes.drainRate.toFixed(1).replace('.0', '')
			}</span>
						</span>`;
		}
		const svg = document.querySelector<SVGSVGElement>('#extraMode');
		if (svg) {
			const color = this.color;
			svg.innerHTML = extraMode
				.replace('stroke="white"', `stroke="${color}"`)
				.replace('fill="white"', `fill="${color}"`);
		}
		const sr = document.querySelector<HTMLSpanElement>('#masterSR');
		if (sr) {
			sr.textContent = `${this.difficultyAttributes.starRating.toFixed(2)}★`;
		}
	}

	private constructConnectorsAsync() {
		return Promise.all(
			this.data.hitObjects.map((_, i, arr) => {
				return new Promise<DrawableFollowPoints | null>((resolve) => {
					setTimeout(() => {
						if (i === arr.length - 1) {
							resolve(null);
							return;
						}

						const startObject = arr[i];
						const endObject = arr[i + 1];

						if (endObject.isNewCombo) {
							resolve(null);
							return;
						}

						resolve(
							new DrawableFollowPoints(startObject, endObject).hook(
								this.context
							)
						);
					});
				});
			})
		);
	}

	private constructConnectorsSync() {
		const connectors = [];
		for (let i = 0; i < this.data.hitObjects.length - 1; i++) {
			const startObject = this.data.hitObjects[i];
			const endObject = this.data.hitObjects[i + 1];
			if (endObject.isNewCombo) continue;

			connectors.push(
				new DrawableFollowPoints(startObject, endObject).hook(this.context)
			);
		}

		return connectors;
	}

	private async constructConnectors() {
		const async = inject<ExperimentalConfig>(
			'config/experimental'
		)?.asyncLoading;

		if (async) return await this.constructConnectorsAsync();
		return this.constructConnectorsSync();
	}

	private loadHitObjectsSync(sliderLayer: BeatmapSliderLayer) {
		this.objects = this.data.hitObjects
			.map((object) => {
				if (object instanceof Circle) {
					return new DrawableHitCircle(object).hook(this.context);
				}
				if (object instanceof Slider) {
					return new DrawableSlider(object, sliderLayer).hook(this.context);
				}
				if (object instanceof Spinner) {
					return new DrawableSpinner(object).hook(this.context);
				}
				return null;
			})
			.filter((object) => object !== null);
	}

	private async loadHitObjectsAsync(sliderLayer: BeatmapSliderLayer) {
		this.objects = (
			await Promise.all(
				this.data.hitObjects.map((object) => {
					return new Promise<DrawableHitObject | null>((resolve) => {
						setTimeout(() => {
							if (object instanceof Circle) {
								resolve(new DrawableHitCircle(object).hook(this.context));
							} else if (object instanceof Slider) {
								resolve(new DrawableSlider(object, sliderLayer).hook(this.context));
							} else if (object instanceof Spinner) {
								resolve(new DrawableSpinner(object).hook(this.context));
							}
							resolve(null);
						});
					});
				})
			)
		).filter((object) => object !== null);
	}
}