import { Tween } from '@tweenjs/tween.js';
import { DifficultyPoint, SamplePoint, TimingPoint } from 'osu-classes';
import { Application, Assets, type FederatedWheelEvent, Texture, TickerCallback } from 'pixi.js';
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
	private storyboard?: Storyboard;

	constructor(private resources: Map<string, Blob>) {
		super();
		this.playbackRate = inject<ExperimentalConfig>('config/experimental')
			?.doubleTime
			? 1.5
			: 1;

		this.context.provide('beatmapset', this);

		provide('beatmapset', this);
		this.lifetime.use(
			inject<Application>('ui/app')?.ticker.add(this.frame),
			(t) => t?.remove(this.frame)
		);

		this.lifetime.use(inject<ExperimentalConfig>('config/experimental')?.onChange(
			'mods',
			({
				 mods: val,
				 shouldPlaybackChange
			 }: {
				mods: string;
				shouldPlaybackChange: boolean;
			}) => {
				if (!shouldPlaybackChange) return;
				this.playbackRate = val.includes('DT') ? 1.5 : 1;

				const audio = this.context.consume<Audio>('audio');
				if (!audio) return;

				audio.onPlaybackRateChange();

				this.master?.onPlaybackRateChange(this.playbackRate);
				for (const slave of this.slaves) {
					slave.onPlaybackRateChange(this.playbackRate);
				}
			}
		));
	}

	async loadBeatmapSkin() {
		const skin = this.context.provide<Skin>(
			'beatmapSkin',
			new Skin(this.resources)
		);
		await skin.init();
	}

	loadResources() {
		inject<Loading>('ui/loading')?.setText('Loading resources');

		console.time('Load hitSamples');
		const sampleManager = this.context.provide('sampleManager', new SampleManager(this.resources));

		return Promise.all([
			sampleManager.load(this.audioContext).then(() => console.timeEnd('Load hitSamples')),
			this.loadBeatmapSkin(),
			this.loadStoryboard()
		]);
	}

	async getDifficulties() {
		const osuFiles = [...this.resources].filter(([filename]) =>
			filename.toLowerCase().endsWith('.osu')
		);

		this.difficulties = (
			await Promise.all(
				osuFiles.map(async ([, blob]) => {
					if (!blob) return null;

					const raw = await blob.text();
					if (!raw) return null;

					return new Beatmap(raw, this).hook(this.context);
				})
			)
		)
			.filter((beatmap): beatmap is Beatmap => beatmap !== null)
			.sort(
				(a, b) =>
					b.difficultyAttributes.starRating -
					a.difficultyAttributes.starRating
			);

		const el = document.querySelector<HTMLDivElement>('#diffsContainer');
		if (!el) return;

		el.innerHTML = '';

		const wrapper = document.querySelector<HTMLDivElement>(
			'#diffsContainerWrapper'
		);

		const config = inject<ExperimentalConfig>('config/experimental');

		const modeIcon = extraMode
			.replaceAll('stroke="white"', 'stroke="currentColor"')
			.replaceAll('fill="white"', 'fill="currentColor"');

		const closeDiffs = () => {
			wrapper?.classList.add('showOut');
			wrapper?.classList.remove('showIn');
		};

		const updateDifficultyVisual = (
			icon: HTMLSpanElement,
			ratingEl: HTMLDivElement,
			difficulty: Beatmap
		) => {
			const starRating = difficulty.difficultyAttributes.starRating;

			icon.style.color = getDiffColour(starRating);
			ratingEl.textContent = `${starRating.toFixed(2)}★`;
		};

		const fragment = document.createDocumentFragment();

		for (let i = 0; i < this.difficulties.length; i++) {
			const difficulty = this.difficulties[i];

			const div = document.createElement('div');
			div.className = 'flex gap-2.5 items-center';

			const button = document.createElement('button');
			button.className =
				'flex w-full items-center gap-2.5 p-2.5 hover:bg-white/10 cursor-pointer transition-colors rounded-[10px] text-white';

			const icon = document.createElement('span');
			icon.className = 'shrink-0';
			icon.innerHTML = modeIcon;

			const title = document.createElement('span');
			title.className = 'flex-1 text-left';
			title.textContent = difficulty.data.metadata.version;

			const rating = document.createElement('div');

			updateDifficultyVisual(icon, rating, difficulty);

			this.lifetime.use(config?.onChange(
				'mods',
				({ shouldPlaybackChange }: { shouldPlaybackChange: boolean }) => {
					if (!shouldPlaybackChange) return;
					updateDifficultyVisual(icon, rating, difficulty);
				}
			));

			button.append(icon, title, rating);

			button.addEventListener('click', () => {
				this.loadMaster(i);
				closeDiffs();
			});

			const button2 = document.createElement('button');
			button2.innerHTML = `<i class="ri-add-line"></i>`;
			button2.className =
				'h-full hover:bg-white/10 p-2.5 flex items-center justify-center rounded-[10px] cursor-pointer transition-colors text-white';
			button2.style.aspectRatio = '1 / 1';

			button2.addEventListener('click', () => {
				this.loadSlave(i);
				closeDiffs();
			});

			div.append(button, button2);
			fragment.append(div);
		}

		el.append(fragment);
	}

	async loadAudio(beatmap: Beatmap) {
		if (beatmap.data.general.audioFilename === this.audioKey) return;

		this.audioKey = beatmap.data.general.audioFilename;
		console.time('Constructing audio');
		const audioFile = this.resources.get(this.audioKey.toLowerCase());

		if (!audioFile) throw new Error('Cannot find audio in resource?');

		inject<Spectrogram>('ui/sidepanel/modding/spectrogram')?.unloadTexture();

		const gainNode = this.context.provide('masterGainNode', this.audioContext.createGain());
		gainNode.connect(this.audioContext.destination);

		gainNode.gain.value = inject<AudioConfig>('config/audio')?.masterVolume ?? 0.8;
		this.lifetime.use(inject<AudioConfig>('config/audio')?.onChange('masterVolume', (val) => {
			gainNode.gain.value = val;
		}));

		const audio = this.context.provide(
			'audio',
			new Audio(gainNode, this).hook(this.context)
		);
		await audio.createBufferNode(audioFile, beatmap);

		console.timeEnd('Constructing audio');

		const graph = inject<DifficultyGraph>('ui/sidepanel/modding/difficulty');
		if (!graph) return;

		graph.setData(beatmap.strains, audio.duration / 1000);
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
		const videoResource = this.resources.get(
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
		const backgroundResource = this.resources.get(beatmap.data.events.backgroundPath?.toLowerCase() ?? '');

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
		const storyboardKey = this.resources.keys().find((key) => key.includes('.osb'));
		if (!storyboardKey) return;

		const storyboardFile = this.resources.get(storyboardKey.toLowerCase());

		const storyboard = new Storyboard(storyboardFile!, this.resources);
		await storyboard.loadTextures();

		inject<Background>('ui/main/viewer/background')?.injectStoryboardContainer(
			storyboard.container
		);
		await storyboard.loadCurrent();

		this.storyboard = storyboard;
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

		const storyboard = this.storyboard;
		await Promise.all([
			this.loadAudio(beatmap),
			this.loadVideo(beatmap),
			this.loadBackground(beatmap),
			storyboard?.loadMaster(beatmap.raw).then(() => {
				storyboard?.checkRemoveBG(this);
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
			this.master?.reset();
			this.master = undefined;

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

		beatmap.reset();
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

		this.master?.seek(time);
		for (const slave of this.slaves) {
			slave.seek(time);
		}

		this.context.consume<Video>('video')?.seek(time);
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

	override destroy() {
		inject<Application>('ui/app')?.ticker.remove(this.frame);
		const audio = this.context.consume<Audio>('audio');
		if (audio?.state === 'PLAYING') {
			const playButton = inject<Play>('ui/main/controls/play');
			if (playButton) playButton.sprite.texture = Texture.from('play.png');
		}

		audio?.destroy();

		inject<Timeline>('ui/main/viewer/timeline')?.loadObjects([]);
		inject<Background>('ui/main/viewer/background')?.ejectStoryboardContainer();

		this.storyboard?.destroy();

		for (const slave of this.difficulties) {
			slave.destroy();
		}

		this.context.consume<Video>('video')?.destroy();
		inject<Spectrogram>('ui/sidepanel/modding/spectrogram')?.unloadTexture();

		provide('beatmapset', undefined);

		super.destroy();
	}

	private readonly frame: TickerCallback<undefined> = () => {
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

		this.storyboard?.update(time);
	};

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
