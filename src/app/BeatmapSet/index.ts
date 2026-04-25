import { Tween } from '@tweenjs/tween.js';
import { DifficultyPoint, SamplePoint, TimingPoint } from 'osu-classes';
import { Application, Assets, type FederatedWheelEvent, Texture } from 'pixi.js';

import extraMode from '../../assets/extra-mode.svg?raw';
import Audio from '../Audio/index.ts';
import AudioConfig from '../Config/AudioConfig.ts';
import BackgroundConfig from '../Config/BackgroundConfig.ts';
import ExperimentalConfig from '../Config/ExperimentalConfig.ts';
import TimelineConfig from '../Config/TimelineConfig.ts';
import { inject, provide, ScopedClass } from '../Context.ts';
import Skin from '../Skinning/Skin.ts';
import { tweenGroup } from '../UI/animation/AnimationController.ts';
import Easings from '../UI/Easings.ts';
import Loading from '../UI/loading/index.ts';
import Play from '../UI/main/controls/Play.ts';
import ProgressBar from '../UI/main/controls/ProgressBar.ts';
import Timestamp from '../UI/main/controls/Timestamp.ts';
import Background from '../UI/main/viewer/Background.ts';
import Gameplays from '../UI/main/viewer/Gameplay/Gameplays.ts';
import Timeline from '../UI/main/viewer/Timeline/index.ts';
import Metadata from '../UI/sidepanel/Metadata.ts';
import DifficultyGraph from '../UI/sidepanel/Modding/DifficultyGraph.ts';
import Spectrogram from '../UI/sidepanel/Modding/Spectrogram.ts';
import Timing from '../UI/sidepanel/Timing/index.ts';
import { getDiffColour, loadColorPalette } from '../utils.ts';
import Video from '../Video/index.ts';
import { Resource } from '../ZipHandler/index.ts';
import DrawableHitCircle from './Beatmap/HitObjects/DrawableHitCircle.ts';
import DrawableSlider from './Beatmap/HitObjects/DrawableSlider.ts';
import Beatmap from './Beatmap/index.ts';
import Storyboard from './Beatmap/Storyboard/index.ts';
import SampleManager from './SampleManager.ts';

export default class BeatmapSet extends ScopedClass {
	difficulties: Beatmap[] = [];
	playbackRate = 1;
	master?: Beatmap;
	slaves: Set<Beatmap> = new Set();
	audioKey = '';
	videoKey: string | null = null;
	backgroundKey: string | null = null;
	cacheBPM?: TimingPoint;
	cacheSV?: DifficultyPoint;
	cacheSample?: SamplePoint;
	_currentNextTick?: number;
	_currentTween?: Tween;
	isSeeking = false;
	audioContext = new AudioContext;

	constructor(private resources: Map<string, Resource>) {
		super();
		this.playbackRate = inject<ExperimentalConfig>('config/experimental')
			?.doubleTime
			? 1.5
			: 1;

		this.context.provide('resources', resources);
		this.context.provide('beatmapset', this);

		provide('beatmapset', this);
		inject<Application>('ui/app')?.ticker.add(() => this.frame(), this);

		inject<ExperimentalConfig>('config/experimental')?.onChange(
			'mods',
			async ({
					   mods: val,
					   shouldPlaybackChange
				   }: {
				mods: string;
				shouldPlaybackChange: boolean;
			}) => {
				if (!shouldPlaybackChange) return;

				await this.toggle();
				this.playbackRate = val.includes('DT') ? 1.5 : 1;
				await this.toggle();
			}
		);
	}

	async loadBeatmapSkin() {
		const skin = this.context.provide<Skin>(
			'beatmapSkin',
			new Skin(this.context.consume<Map<string, Resource>>('resources'))
		);
		await skin.init();
	}

	async loadResources() {
		inject<Loading>('ui/loading')?.setText('Loading hitSamples');

		console.time('Load hitSamples');
		const sampleManager = this.context.provide('sampleManager', new SampleManager(this.resources));
		await sampleManager.load(this.audioContext);
		console.timeEnd('Load hitSamples');

		await this.loadBeatmapSkin();

		await this.loadStoryboard();
	}

	async getDifficulties() {
		const osuFiles =
			[...this.resources].filter(
				([filename]) => filename.split('.').at(-1) === 'osu'
			) ?? [];

		this.difficulties = (
			await Promise.all<Promise<Beatmap | null>[]>(
				osuFiles.map(async ([_, blob]) => {
					const rawString = await blob?.text();

					if (!rawString) return null;
					return new Beatmap(rawString).hook(this.context);
				})
			)
		)
			.filter((beatmap) => beatmap !== null)
			.sort(
				(a, b) =>
					-a.difficultyAttributes.starRating +
					b.difficultyAttributes.starRating
			);

		const el = document.querySelector<HTMLDivElement>('#diffsContainer');
		if (el) el.innerHTML = '';
		for (let i = 0; i < this.difficulties.length; i++) {
			const difficulty = this.difficulties[i];
			const div = document.createElement('div');
			div.className = 'flex gap-2.5 items-center';

			const button = document.createElement('button');
			button.className =
				'flex w-full items-center gap-2.5 p-2.5 hover:bg-white/10 cursor-pointer transition-colors rounded-[10px] text-white';
			const color = getDiffColour(
				this.difficulties[i].difficultyAttributes.starRating
			);
			button.innerHTML = `${extraMode.replace('stroke="white"', `stroke="${color}"`).replace('fill="white"', `fill="${color}"`)}

            <span class="flex-1 text-left">${difficulty.data.metadata.version}</span>
            <div>${this.difficulties[i].difficultyAttributes.starRating.toFixed(2)}★</div>`;
			button.addEventListener('click', () => {
				this.loadMaster(i);
				document
					.querySelector<HTMLDivElement>('#diffsContainerWrapper')
					?.classList.add('showOut');
				document
					.querySelector<HTMLDivElement>('#diffsContainerWrapper')
					?.classList.remove('showIn');
			});

			const button2 = document.createElement('button');
			button2.innerHTML = `<i class="ri-add-line"></i>`;
			button2.className =
				'h-full hover:bg-white/10 p-2.5 flex items-center justify-center rounded-[10px] cursor-pointer transition-colors text-white';
			button2.style.aspectRatio = '1 / 1';
			button2.addEventListener('click', () => {
				this.loadSlave(i);

				document
					.querySelector<HTMLDivElement>('#diffsContainerWrapper')
					?.classList.add('showOut');
				document
					.querySelector<HTMLDivElement>('#diffsContainerWrapper')
					?.classList.remove('showIn');
			});

			div?.append(button, button2);

			el?.append(div);
		}
	}

	async loadAudio(beatmap: Beatmap) {
		if (beatmap.data.general.audioFilename === this.audioKey) return;

		this.audioKey = beatmap.data.general.audioFilename;
		console.time('Constructing audio');
		const audioFile = this.context
			.consume<Map<string, Resource>>('resources')
			?.get(this.audioKey.toLowerCase());

		if (!audioFile) throw new Error('Cannot find audio in resource?');

		inject<Spectrogram>('ui/sidepanel/modding/spectrogram')?.unloadTexture();

		this.context.consume<Audio>('audio')?.destroy();

		const gainNode = this.context.provide('masterGainNode', this.audioContext.createGain());
		gainNode.connect(this.audioContext.destination);

		gainNode.gain.value = inject<AudioConfig>('config/audio')?.masterVolume ?? 0.8;
		inject<AudioConfig>('config/audio')?.onChange('masterVolume', (val) => {
			gainNode.gain.value = val;
		});

		const audio = this.context.provide(
			'audio',
			new Audio(gainNode, this).hook(this.context)
		);
		await audio.createBufferNode(audioFile, beatmap);

		inject<DifficultyGraph>('ui/sidepanel/modding/difficulty')?.setData(
			beatmap.strains,
			audio.duration / 1000
		);

		console.timeEnd('Constructing audio');
	}

	loadVideo(beatmap: Beatmap) {
		const videoFilePath =
			beatmap.data.events.storyboard?.layers.get('Video')?.elements.at(0)
				?.filePath ?? '';

		if (this.videoKey === videoFilePath) return;
		if (videoFilePath === '') {
			inject<Background>('ui/main/viewer/background')?.updateFrame();
		}

		this.videoKey = videoFilePath;
		const videoResource = this.context
			.consume<Map<string, Resource>>('resources')
			?.get(
				(
					beatmap.data.events.storyboard?.layers.get('Video')?.elements.at(0)
						?.filePath ?? ''
				).toLowerCase()
			);

		if (!videoResource) return;

		inject<Loading>('ui/loading')?.setText('Loading video');

		const bg = inject<Background>('ui/main/viewer/background');
		if (bg) bg.init = false;

		const video = this.context.provide('video', new Video());
		try {
			video.load(
				videoResource,
				beatmap.data.events.storyboard?.layers.get('Video')?.elements.at(0)
					?.startTime ?? 0
			);
		} catch (e) {
			console.error(e);
		}
	}

	async loadBackground(beatmap: Beatmap) {
		if (this.backgroundKey === beatmap.data.events.backgroundPath) return;

		this.backgroundKey = beatmap.data.events.backgroundPath;
		const background = inject<Background>('ui/main/viewer/background');
		const backgroundResource = this.context
			.consume<Map<string, Resource>>('resources')
			?.get(beatmap.data.events.backgroundPath?.toLowerCase() ?? '');

		if (!backgroundResource) return;

		inject<Loading>('ui/loading')?.setText('Loading background');

		const url = URL.createObjectURL(backgroundResource);
		background?.updateTexture(
			await Assets.load({ src: url, parser: 'texture' })
		);

		document.body.style.backgroundImage = `url("${url}")`;
		await loadColorPalette(url);

		URL.revokeObjectURL(url);
	}

	async loadStoryboard() {
		const storyboardKey = this.context
			.consume<Map<string, Resource>>('resources')
			?.keys()
			.find((key) => key.includes('.osb'));
		if (!storyboardKey) return;

		const storyboardFile = this.context
			.consume<Map<string, Resource>>('resources')
			?.get(storyboardKey.toLowerCase());

		const storyboard = this.context.provide(
			'storyboard',
			// biome-ignore lint/style/noNonNullAssertion: I found it already cmon!
			new Storyboard(storyboardFile!)
		);
		storyboard.hook(this.context);
		await storyboard.loadTextures();
		inject<Background>('ui/main/viewer/background')?.injectStoryboardContainer(
			storyboard.container
		);
		await storyboard.loadCurrent();
	}

	async loadPeripherals(beatmap: Beatmap) {
		inject<Loading>('ui/loading')?.setText('Loading audio and background');

		document.title = `${beatmap.data.metadata.artist} - ${beatmap.data.metadata.title} [${beatmap.data.metadata.version}] | JoSu!`;

		const el = document.querySelector<HTMLSpanElement>('#masterDiff');
		if (el) {
			el.innerHTML = `
            <span class="truncate">${beatmap.data.metadata.version}</span>
            <br/>
            <span class="text-xs">
                CS <span class="font-medium">${beatmap.data.difficulty.circleSize.toFixed(1).replace('.0', '')}</span> / 
                AR <span class="font-medium">${beatmap.difficultyAttributes.approachRate.toFixed(1).replace('.0', '')}</span> / 
                OD <span class="font-medium">${beatmap.difficultyAttributes.overallDifficulty.toFixed(1).replace('.0', '')}</span> / 
                HP <span class="font-medium">${beatmap.difficultyAttributes.drainRate.toFixed(1).replace('.0', '')}</span> 
            </span>`;
		}
		const svg = document.querySelector<SVGSVGElement>('#extraMode');
		if (svg) {
			const color = getDiffColour(beatmap.difficultyAttributes.starRating);
			svg.innerHTML = extraMode
				.replace('stroke="white"', `stroke="${color}"`)
				.replace('fill="white"', `fill="${color}"`);
		}
		const sr = document.querySelector<HTMLSpanElement>('#masterSR');
		if (sr)
			sr.textContent = `${beatmap.difficultyAttributes.starRating.toFixed(2)}★`;

		const storyboard = this.context.consume<Storyboard>('storyboard');
		await Promise.all([
			this.loadAudio(beatmap),
			this.loadVideo(beatmap),
			this.loadBackground(beatmap),
			storyboard?.loadMaster(beatmap.raw).then(() => {
				storyboard?.checkRemoveBG();
				storyboard?.sortChildren();
			})
		]);
		inject<Metadata>('ui/sidepanel/metadata')?.updateMetadata(beatmap.data);

		await beatmap.loadTimingPoints();
	}

	loadBeatmap(beatmap: Beatmap, index?: number) {
		inject<Loading>('ui/loading')?.setText('Loading hitObjects');

		inject<Gameplays>('ui/main/viewer/gameplays')?.addGameplay(
			beatmap.container,
			index
		);

		beatmap.load();
		return beatmap.loadHitObjects();

		// console.log(beatmap);
	}

	async loadMaster(idx: number) {
		const beatmap = this.difficulties[idx];
		if (!beatmap) return;
		if (this.master === beatmap) return;

		const oldMaster = this.master;
		const isSwitch = this.slaves.has(beatmap);

		inject<Loading>('ui/loading')?.on();
		beatmap.container.spinner.spin = true;

		if (isSwitch && oldMaster) {
			await this.loadPeripherals(beatmap);
			inject<Gameplays>('ui/main/viewer/gameplays')?.switchGameplay(
				beatmap.container,
				oldMaster.container
			);

			this.slaves.delete(beatmap);
			this.slaves.add(oldMaster);
		} else {
			this.master?.destroy();

			await Promise.all([
				this.loadPeripherals(beatmap),
				this.loadBeatmap(beatmap, 0)
			]);
		}

		inject<Timeline>('ui/main/viewer/timeline')?.loadObjects(
			beatmap.objects as (DrawableHitCircle | DrawableSlider)[]
		);

		this.master = beatmap;

		this.setIds();

		beatmap.container.spinner.spin = false;
		inject<Loading>('ui/loading')?.off();
	}

	async loadSlave(idx: number) {
		const beatmap = this.difficulties[idx];
		if (!beatmap) return;
		if (beatmap === this.master || this.slaves.has(beatmap)) return;

		await this.loadBeatmap(beatmap);
		this.slaves.add(beatmap);

		beatmap.container.spinner.spin = false;

		this.setIds();
	}

	unloadSlave(idx: number) {
		const beatmap = this.difficulties[idx];
		if (!beatmap) return;
		if (beatmap === this.master || !this.slaves.has(beatmap)) return;

		beatmap.destroy();
		this.slaves.delete(beatmap);

		this.setIds();
	}

	async toggle(event: UIEvent | null = null) {
		const playButton = inject<Play>('ui/main/controls/play');

		const audio = this.context.consume<Audio>('audio');
		await audio?.toggle(event);

		this.master?.toggle();
		for (const slave of this.slaves) {
			slave.toggle();
		}

		if (
			audio?.state === 'PLAYING' &&
			inject<BackgroundConfig>('config/background')?.video
		) {
			this.context.consume<Video>('video')?.play(audio?.currentTime);
		}

		if (audio?.state === 'STOPPED') {
			this.context.consume<Video>('video')?.stop(audio?.currentTime);
		}

		this._currentNextTick = audio?.currentTime ?? 0;

		if (playButton) {
			switch (this.context.consume<Audio>('audio')?.state) {
				case 'PLAYING': {
					playButton.sprite.texture = Texture.from('pause.png');
					break;
				}
				case 'STOPPED': {
					playButton.sprite.texture = Texture.from('play.png');
					break;
				}
			}
		}
	}

	seek(time: number) {
		const audio = this.context.consume<Audio>('audio');
		if (!audio) throw new Error('Audio hasn\'t been initialized');

		audio.currentTime = time;

		this.master?.seek(audio.currentTime);
		for (const slave of this.slaves) {
			slave.seek(audio.currentTime);
		}

		this.context.consume<Video>('video')?.seek(audio.currentTime);
	}

	frame() {
		if (!this.master) {
			return;
		}

		const audio = this.context.consume<Audio>('audio');
		if (!audio) {
			return;
		}

		const time = audio.currentTime;

		this.master?.frame(time);
		for (const slave of this.slaves) {
			slave.frame(time);
		}

		const timestamp = inject<Timestamp>('ui/main/controls/timestamp');
		timestamp?.updateDigit(time);

		const currentBPM = this.master.data.controlPoints.timingPointAt(time);
		const currentSV = this.master.data.controlPoints.difficultyPointAt(time);
		const currentSample = this.master.data.controlPoints.samplePointAt(time);

		if (
			this.cacheBPM !== currentBPM ||
			this.cacheSV !== currentSV ||
			this.cacheSample !== currentSample
		) {
			const time = Math.max(
				currentBPM.startTime,
				currentSV.startTime,
				currentSample.startTime
			);
			inject<Timing>('ui/sidepanel/timing')?.scrollToTimingPoint(time);
		}

		if (this.cacheBPM !== currentBPM) {
			this.cacheBPM = currentBPM;
			timestamp?.updateBPM(currentBPM.bpm);
		}

		if (this.cacheSV !== currentSV) {
			this.cacheSV = currentSV;
			timestamp?.updateSliderVelocity(currentSV.sliderVelocity);
		}

		if (this.cacheSample !== currentSample) {
			this.cacheSample = currentSample;
		}

		inject<ProgressBar>('ui/main/controls/progress')?.setPercentage(
			time / audio.duration
		);
		inject<Timeline>('ui/main/viewer/timeline')?.update(time);
		inject<Timeline>('ui/main/viewer/timeline')?.draw(time);

		this.context.consume<Storyboard>('storyboard')?.update(time);
	}

	handleWheel(event: FederatedWheelEvent) {
		const direction = event.deltaY > 0 ? 1 : event.deltaY < 0 ? -1 : 0;
		if (direction === 0) return;

		this.smoothTick(
			direction,
			event.shiftKey,
			this.context.consume<Audio>('audio')?.state === 'PLAYING'
		);
	}

	smoothTick(direction: 1 | -1, miliStep = false, instant = false) {
		const audio = this.context.consume<Audio>('audio');
		if (!audio) return;

		if (!this._currentNextTick) this._currentNextTick = audio.currentTime;

		const nextTick = this.getNextStep(
			direction,
			instant
				? audio.currentTime
				: direction === 1
					? Math.max(this._currentNextTick, audio.currentTime)
					: Math.min(this._currentNextTick, audio.currentTime),
			miliStep
		);
		this._currentNextTick = Math.max(0, nextTick);

		if (!instant) {
			this.smoothSeek(this._currentNextTick);
		}

		if (instant) {
			this._currentTween?.stop();
			this.seek(this._currentNextTick);
		}
	}

	smoothSeek(time: number, duration = 200) {
		if (this._currentTween) {
			this._currentTween.stop();
		}

		const audio = this.context.consume<Audio>('audio');
		if (!audio) return;

		this.isSeeking = true;

		const tween = new Tween({
			value: audio.currentTime
		})
			.easing(Easings.Out)
			.to(
				{
					value: time
				},
				duration
			)
			.onUpdate(({ value }) => this.seek(value))
			.onComplete(() => {
				tweenGroup.remove(tween);
				this.isSeeking = false;
			})
			.onStop(() => {
				tweenGroup.remove(tween);
				this.isSeeking = false;
			})
			.start();

		tweenGroup.add(tween);
		this._currentTween = tween;
	}

	getNextStep(direction: -1 | 1, from?: number, miliStep = false) {
		const audio = this.context.consume<Audio>('audio');
		if (!audio || !this.master) return 0;

		const currentTime = from ?? audio.currentTime;
		const timingPoint =
			this.master.data.controlPoints.timingPointAt(currentTime);
		const divisor = inject<TimelineConfig>('config/timeline')?.divisor ?? 1;

		const beatLength = timingPoint.beatLength / divisor;

		const nextTick =
			timingPoint.startTime +
			(direction +
				Math.floor((currentTime - timingPoint.startTime) / beatLength) +
				0.00000001) *
			beatLength;

		return miliStep ? currentTime + direction : nextTick;
	}

	destroy() {
		inject<Application>('ui/app')?.ticker.remove(() => this.frame());
		const audio = this.context.consume<Audio>('audio');
		if (audio?.state === 'PLAYING') {
			const playButton = inject<Play>('ui/main/controls/play');
			if (playButton) playButton.sprite.texture = Texture.from('play.png');
		}

		audio?.destroy();

		inject<Timeline>('ui/main/viewer/timeline')?.loadObjects([]);
		inject<Background>('ui/main/viewer/background')?.ejectStoryboardContainer();

		this.context.consume<Storyboard>('storyboard')?.destroy();

		for (const slave of this.difficulties) {
			slave.destroy();
			slave.worker.terminate();
		}

		this.context.consume<Video>('video')?.destroy();
		inject<Spectrogram>('ui/sidepanel/modding/spectrogram')?.unloadTexture();

		provide('beatmapset', undefined);
	}

	private setIds() {
		const masterId = this.master?.data.metadata.beatmapId;
		const slavesId = [...this.slaves].map(
			(slave) => slave.data.metadata.beatmapId
		);

		const ids = [masterId, ...slavesId].filter((id) => id !== undefined);

		const url = new URL(globalThis.location.href);
		const params = url.searchParams;

		for (let i = 0; i < ids.length; i++) {
			const id = ids[i];

			if (i === 0) {
				params.set('b', id.toString());
				continue;
			}

			params.append('b', id.toString());
		}

		globalThis.history.replaceState(null, '', url);

		const input = document.querySelector<HTMLInputElement>('#idInput');
		if (!input) return;
		input.value = ids.join(', ');
	}
}
