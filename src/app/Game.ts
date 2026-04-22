import { Application, Assets, GpuBlendModesToPixi, RenderTarget, Spritesheet, UPDATE_PRIORITY } from 'pixi.js';
import uiJsonData from '../assets/atlas/ui.json' with { type: 'json' };

import uiImageAtlas from '../assets/atlas/ui.png';
import Replay from './BeatmapSet/Beatmap/Replay.ts';
import {
	getBeatmapFromExternalUrl,
	getBeatmapFromHash,
	getBeatmapFromId,
	IDType,
	processID
} from './BeatmapSet/BeatmapDownloader.ts';
import BeatmapSet from './BeatmapSet/index.ts';
import Config from './Config/index.ts';
import { inject, provide } from './Context.ts';
import ResponsiveHandler from './ResponsiveHandler.ts';
import SkinManager from './Skinning/SkinManager.ts';
import State from './State.ts';
import AnimationController, { tweenGroup } from './UI/animation/AnimationController.ts';
import Loading from './UI/loading/index.ts';
import Main from './UI/main/index.ts';
import SidePanel from './UI/sidepanel/index.ts';
import ZipHandler from './ZipHandler/index.ts';

export class Game {
	app?: Application;
	animationController = new AnimationController();

	state = provide('state', new State());
	responsiveHandler = provide('responsiveHandler', new ResponsiveHandler());
	config: Config;

	constructor() {
		provide('skinManager', new SkinManager());
		this.config = new Config();

		this.config.experimental.onChange(
			'mods',
			({ mods: modsString }: { mods: string }) => {
				const url = globalThis.location;
				const params = new URLSearchParams(url.search);

				if (modsString === '') {
					params.delete('m');
				} else {
					params.set('m', modsString);
				}

				globalThis.history.replaceState(null, '', `?${params.toString()}`);
			}
		);

		this.config.fullscreen.onChange('fullscreen', (isFullscreen) => {
			const url = new URL(globalThis.location.href);
			const params = url.searchParams;

			if (isFullscreen) {
				params.set('fullscreen', 'true');
				document.body.classList.add('fullscreen');
			} else {
				params.delete('fullscreen');
				document.body.classList.remove('fullscreen');
			}

			globalThis.history.replaceState(null, '', url);
		});
	}

	resizeFrame = (app: Application, width: number, height: number) => {
		app.renderer.resize(width, height);
		app.render();
	};

	async initApplication() {
		RenderTarget.defaultOptions.depth = true;

		const app = new Application();
		await app.init({
			// // biome-ignore lint/style/noNonNullAssertion: It should be there already lol
			// resizeTo: document.querySelector<HTMLDivElement>("#app")!,
			antialias: this.config.renderer.antialiasing,
			backgroundAlpha: 0,
			premultipliedAlpha: false,
			// useBackBuffer: true,
			// clearBeforeRender: true,
			depth: true,
			autoDensity: true,
			resolution: devicePixelRatio,
			sharedTicker: true,
			preference: this.config.renderer.renderer
		});

		(globalThis as typeof globalThis & {
			__PIXI_APP__: typeof app;
		}).__PIXI_APP__ = app;

		app.stage.layout = {
			width: app.screen.width,
			height: app.screen.height,
			flexDirection: 'row',
			gap: 0
		};

		GpuBlendModesToPixi.max = {
			color: {
				operation: 'add',
				srcFactor: 'one',
				dstFactor: 'zero'
			},
			alpha: {
				operation: 'add',
				srcFactor: 'one',
				dstFactor: 'zero'
			}
		};

		const divApp = document.querySelector<HTMLDivElement>('#app');
		if (divApp) {
			const resizeObserver = new ResizeObserver((entries) => {
				for (const entry of entries) {
					if (entry.target !== divApp) continue;

					const width = Math.round(
						+getComputedStyle(divApp).width.replaceAll('px', '')
					);
					const height = Math.round(
						+getComputedStyle(divApp).height.replaceAll('px', '')
					);

					app.ticker.addOnce(
						() => this.resizeFrame(app, width, height),
						UPDATE_PRIORITY.HIGH
					);
				}
			});

			resizeObserver.observe(divApp);
		}

		return app;
	}

	async init() {
		const sheet = new Spritesheet({
			texture: await Assets.load(uiImageAtlas),
			data: uiJsonData
		});
		await sheet.parse();

		Assets.cache.set('', sheet);

		const app = provide('ui/app', await this.initApplication());
		app.ticker.add(
			() => {
				this.resize(app);
				tweenGroup.update();
			},
			undefined,
			UPDATE_PRIORITY.INTERACTION
		);

		this.config.fullscreen.fullscreen =
			new URLSearchParams(globalThis.location.search).get('fullscreen') ===
			'true';

		provide('ui/loading', new Loading());

		app.stage.addChild(
			provide('ui/main', new Main()).container,
			provide('ui/sidepanel', new SidePanel()).container
		);

		this.responsiveHandler.on('layout', (direction) => {
			switch (direction) {
				case 'landscape': {
					app.stage.layout = {
						flexDirection: 'row'
					};
					break;
				}
				case 'portrait': {
					app.stage.layout = {
						flexDirection: 'column'
					};
					break;
				}
			}
		});

		this.state.on('sidebar', (newState) => {
			const ANIMATION_DURATION = 200;
			switch (newState) {
				case 'OPENED': {
					this.animationController.addAnimation(
						'gap',
						0,
						10,
						(val) => app.stage.layout = { gap: val },
						ANIMATION_DURATION
					);
					document.body.classList.add('sidepanel');
					break;
				}
				case 'CLOSED': {
					this.animationController.addAnimation(
						'gap',
						10,
						0,
						(val) => app.stage.layout = { gap: val },
						ANIMATION_DURATION
					);
					document.body.classList.remove('sidepanel');
					break;
				}
			}
		});

		document.querySelector<HTMLDivElement>('#app')?.append(app.canvas);

		document
			.querySelector<HTMLInputElement>('#idInput')
			?.addEventListener('keydown', (event) => {
				if (event.key !== 'Enter') return;

				this.loadFromInput();
			});

		document.querySelector<HTMLButtonElement>('#submitId')
			?.addEventListener('click', () => this.loadFromInput());

		document.addEventListener('dragover', (e) => e.preventDefault());
		document.addEventListener('drop', (e) => {
			e.preventDefault();
			if (!e.dataTransfer?.files.length) return;
			this.processFile(e.dataTransfer.files[0]);
		});

		document.querySelector<HTMLInputElement>('#fileInput')
			?.addEventListener('change', (e) => {
				if (!(e.target as HTMLInputElement)?.files?.length) return;
				this.processFile((e.target as HTMLInputElement)?.files?.[0] as File);
			});

		this.config.renderer.onChange(
			'antialiasing',
			() => globalThis.location.reload()
		);
		this.config.renderer.onChange(
			'renderer',
			() => globalThis.location.reload()
		);

		await inject<SkinManager>('skinManager')?.loadSkins();
		if (await this.loadFromHash() || await this.loadFromQuery()) return;

		const splash = document.querySelector('#splash');
		const splashContainer = document.querySelector('#splashContainer');

		splash?.classList.add('showSplash', 'flex');
		splash?.classList.remove('hidden');
		splashContainer?.classList.add('showContainer');

		document.querySelector('#splashContainer button')
			?.addEventListener('click', () => {
				splash?.classList.remove('showSplash');
				splashContainer?.classList.remove('showContainer');

				splash?.classList.add('hideSplash');
				splashContainer?.classList.add('hideContainer');
			});
	}

	async loadBlob(blob: Blob) {
		const resources = await ZipHandler.extract(blob);
		const bms = new BeatmapSet(resources);

		await bms.loadResources();
		await bms.getDifficulties();

		return bms;
	}

	async loadReplayFromLink(url: string) {
		inject<Loading>('ui/loading')?.on();
		const replay = await getBeatmapFromExternalUrl(url);

		if (!replay) {
			inject<Loading>('ui/loading')?.off();
			return;
		}

		const file = new File([replay], 'replay.osr');
		await this.processFile(file);

		inject<Loading>('ui/loading')?.off();
	}

	private async processFile(file: File) {
		const fileExt = file.name.split('.').at(-1);
		if (!fileExt) return;
		if (!['osz', 'osk', 'osr'].includes(fileExt)) return;

		if (fileExt === 'osz') {
			inject<Loading>('ui/loading')?.on();
			inject<Loading>('ui/loading')?.setText('Importing beatmapset ');

			try {
				inject<BeatmapSet>('beatmapset')?.destroy();
				await this.loadBlob(new Blob([file]));
			} catch (e) {
				console.error(e);
			}

			inject<Loading>('ui/loading')?.off();
			document
				.querySelector<HTMLDivElement>('#diffsContainerWrapper')
				?.classList.remove('hidden');
			document
				.querySelector<HTMLDivElement>('#diffsContainerWrapper')
				?.classList.remove('showOut');
			document
				.querySelector<HTMLDivElement>('#diffsContainerWrapper')
				?.classList.add('showIn');

			return;
		}

		if (fileExt === 'osk') {
			inject<Loading>('ui/loading')?.on();
			inject<Loading>('ui/loading')?.setText('Loading skin');
			const resource = await ZipHandler.extract(new Blob([file]));
			await inject<SkinManager>('skinManager')?.addSkin(resource);
			inject<Loading>('ui/loading')?.off();
		}

		if (fileExt === 'osr') {
			const bms = inject<BeatmapSet>('beatmapset');

			const replay = new Replay();
			await replay.process(new Blob([file]));

			const hookReplay = async () => {
				if (!replay.data?.info.beatmapHashMD5) return;
				await this.loadHash(replay.data?.info.beatmapHashMD5);

				const bms = inject<BeatmapSet>('beatmapset');

				const bm = bms?.difficulties.findIndex(
					(bm) => bm.md5 === replay.data?.info.beatmapHashMD5
				);
				if (bm !== -1 && bm !== undefined && bm !== null) {
					bms?.difficulties[bm].hookReplay(replay);
				}
			};

			if (!bms) {
				await hookReplay();
				return;
			}

			const bm = bms?.difficulties.findIndex(
				(bm) => bm.md5 === replay.data?.info.beatmapHashMD5
			);

			if (bm === -1 || bm === undefined || bm === null) {
				const container = document.createElement('div');
				const text = document.createElement('div');
				const buttons = document.createElement('div');
				const fetch = document.createElement('button');
				const force = document.createElement('button');
				const cancel = document.createElement('button');

				text.innerText =
					'Cannot find beatmap matching with the replay hash. Please select the following options.';
				fetch.innerText = 'Fetch from online source';
				force.innerText = 'Force using replay';
				cancel.innerText = 'Cancel';

				if (replay.data?.info.beatmapHashMD5) {
					buttons.append(fetch);
				}
				buttons.append(force, cancel);

				container.append(text, buttons);

				container.classList.add(
					'absolute',
					'top-[50%]',
					'left-[50%]',
					'-translate-[50%]',
					'w-[600px]',
					'max-w-full',
					'p-8',
					'flex',
					'flex-col',
					'gap-5',
					'rounded-xl',
					'border',
					'border-surface-1',
					'bg-base',
					'text-text'
				);
				buttons.classList.add('flex', 'items-center', 'justify-end', 'gap-2.5');
				cancel.classList.add(
					'p-2',
					'px-4',
					'bg-crust',
					'rounded-lg',
					'hover:bg-mantle',
					'text-text',
					'text-sm',
					'cursor-pointer'
				);
				fetch.classList.add(
					'p-2',
					'px-4',
					'bg-text',
					'rounded-lg',
					'hover:bg-subtext-0',
					'text-mantle',
					'text-sm',
					'cursor-pointer'
				);
				force.classList.add(
					'p-2',
					'px-4',
					'bg-surface-0',
					'rounded-lg',
					'hover:bg-surface-1',
					'text-text',
					'text-sm',
					'cursor-pointer'
				);

				cancel.addEventListener('click', () => {
					document.body.removeChild(container);
				});

				force.addEventListener('click', () => {
					bms?.master?.hookReplay(replay);
					document.body.removeChild(container);
				});

				fetch.addEventListener('click', async () => {
					await hookReplay();
					document.body.removeChild(container);
				});

				document.body.append(container);
			} else {
				if (
					bms?.master !== bms?.difficulties[bm] &&
					!bms?.slaves.has(bms?.difficulties[bm])
				) {
					await bms?.loadMaster(bm);
				}
				bms?.difficulties[bm]?.hookReplay(replay);
			}
		}
	}

	private async loadFromHash() {
		const url = new URL(globalThis.location.href).hash.slice(1);
		if (!url) return false;

		inject<Loading>('ui/loading')?.on();

		try {
			const blob = await getBeatmapFromExternalUrl(url);
			if (!blob) return false;

			await this.loadBlob(blob);
		} catch (e) {
			console.error(e);
		}

		inject<Loading>('ui/loading')?.off();

		document
			.querySelector<HTMLDivElement>('#diffsContainerWrapper')
			?.classList.remove('hidden');
		document
			.querySelector<HTMLDivElement>('#diffsContainerWrapper')
			?.classList.remove('showOut');
		document
			.querySelector<HTMLDivElement>('#diffsContainerWrapper')
			?.classList.add('showIn');

		return true;
	}

	private async loadFromQuery() {
		const searchParams = new URLSearchParams(globalThis.location.search);

		const queries = searchParams.getAll('b');
		const IDs = queries.length !== 0 ? queries : [];

		const replay = searchParams.get('r');

		if (IDs.length === 0 && !replay) {
			inject<Loading>('ui/loading')?.off();
			return false;
		}

		if (IDs.length !== 0) {
			await this.loadIDs(IDs);
		}

		if (replay) {
			await this.loadReplayFromLink(replay);
		}

		return true;
	}

	private async loadFromInput() {
		const input = document.querySelector<HTMLInputElement>('#idInput');
		const entries = input?.value.split(',').map((id) => processID(id.trim()));

		input?.blur();

		if (!entries?.length) return;

		if (entries[0]?.type === IDType.BEATMAP_SET) {
			await this.loadSetID(entries[0].id);
			return;
		}

		await this.loadIDs(
			entries
				.filter((entry) => entry?.type === IDType.BEATMAP)
				.map((entry) => entry?.id ?? null)
				.filter((entry) => entry !== null)
		);
	}

	private async loadIDs(IDs: string[]) {
		inject<Loading>('ui/loading')?.on();

		try {
			let bms = inject<BeatmapSet>('beatmapset');
			if (
				!bms ||
				!bms?.difficulties.some(
					(diff) => diff.data.metadata.beatmapId === +IDs[0]
				)
			) {
				bms?.destroy();
				const blob = await getBeatmapFromId(IDs[0]);

				if (blob === null) {
					console.warn('Cannot download beatmap');
					return;
				}

				bms = await this.loadBlob(blob);
			}

			if (IDs.length === 0) {
				await bms.loadMaster(0);
			}

			for (let i = 0; i < IDs.length; i++) {
				const ID = IDs[i];

				const idx = bms.difficulties.findIndex(
					(diff) => diff.data.metadata.beatmapId === +ID
				);

				if (idx === -1) continue;
				if (i === 0) await bms.loadMaster(idx);
				if (i !== 0) await bms.loadSlave(idx);
			}

			if (!bms.master) {
				document
					.querySelector<HTMLDivElement>('#diffsContainerWrapper')
					?.classList.remove('hidden');
				document
					.querySelector<HTMLDivElement>('#diffsContainerWrapper')
					?.classList.remove('showOut');
				document
					.querySelector<HTMLDivElement>('#diffsContainerWrapper')
					?.classList.add('showIn');
			}
		} catch (e) {
			console.error(e);
		} finally {
			inject<Loading>('ui/loading')?.off();
		}
	}

	private async loadSetID(ID: string) {
		inject<Loading>('ui/loading')?.on();

		try {
			let bms = inject<BeatmapSet>('beatmapset');
			if (
				!bms ||
				!bms?.difficulties.some(
					(diff) => diff.data.metadata.beatmapSetId === +ID
				)
			) {
				bms?.destroy();
				const blob = await getBeatmapFromId('', ID);

				if (blob === null) {
					console.warn('Cannot download beatmap');
					return;
				}

				bms = await this.loadBlob(blob);
			}

			if (!bms.master) {
				document
					.querySelector<HTMLDivElement>('#diffsContainerWrapper')
					?.classList.remove('hidden');
				document
					.querySelector<HTMLDivElement>('#diffsContainerWrapper')
					?.classList.remove('showOut');
				document
					.querySelector<HTMLDivElement>('#diffsContainerWrapper')
					?.classList.add('showIn');
			}
		} catch (e) {
			console.error(e);
		} finally {
			inject<Loading>('ui/loading')?.off();
		}
	}

	private async loadHash(hash: string) {
		inject<Loading>('ui/loading')?.on();

		try {
			let bms = inject<BeatmapSet>('beatmapset');
			if (!bms || !bms?.difficulties.some((diff) => diff.md5 === hash)) {
				bms?.destroy();
				const blob = await getBeatmapFromHash(hash);

				if (blob === null) {
					console.warn('Cannot download beatmap');
					return;
				}

				bms = await this.loadBlob(blob);
			}

			const idx = bms.difficulties.findIndex((diff) => diff.md5 === hash);
			if (idx !== -1) await bms.loadMaster(idx);
		} catch (e) {
			console.error(e);
		} finally {
			inject<Loading>('ui/loading')?.off();
		}
	}

	private resize(app: Application) {
		const width = app.screen.width;
		const height = app.screen.height;

		const _width = app.stage.layout?._computedLayout.width;
		const _height = app.stage.layout?._computedLayout.height;

		this.responsiveHandler.responsive();

		if (_width === width && _height === height) return;

		app.stage.layout = {
			width,
			height
		};
	}
}
