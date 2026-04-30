import IntervalTree from '@flatten-js/interval-tree';
import {
	StoryboardAnimation as StoryboardAnimationData,
	StoryboardDecoder,
	StoryboardLayerType,
	StoryboardSprite as StoryboardSpriteData
} from '@rian8337/osu-base';
import { Assets, Container, Graphics, GraphicsContext, Rectangle, type Texture } from 'pixi.js';
import BackgroundConfig from '../../../Config/BackgroundConfig.ts';
import { inject } from '../../../Context.ts';
import BeatmapSet from '../../index.ts';
import { StoryboardAnimation } from './StoryboardAnimation.ts';
import StoryboardSprite from './StoryboardSprite.ts';
import { Buffer } from 'node:buffer';
import ConfigSection, { ChangeRemover } from '../../../Config/ConfigSection.ts';

export default class Storyboard {
	container: Container = new Container({
		visible: inject<BackgroundConfig>('config/background')?.storyboard
	});
	backgroundLayer = new Container({
		interactive: false,
		interactiveChildren: false,
		sortableChildren: true
	});
	foregroundLayer = new Container({
		interactive: false,
		interactiveChildren: false,
		sortableChildren: false
	});
	overlayLayer = new Container({
		interactive: false,
		interactiveChildren: false,
		sortableChildren: false
	});
	fill: Graphics;
	startTime: number = Infinity;
	private sprites!: StoryboardSprite[];
	private masterSprites!: StoryboardSprite[];
	private _masterTree?: IntervalTree;
	private _tree?: IntervalTree;
	private _previous = new Set<number>();
	private _previousMaster = new Set<number>();
	private remover: ChangeRemover;

	constructor(private blob: Blob, private resources: Map<string, Blob>) {
		const mask = new Graphics()
			.rect(-106.666666667, 0, 853.333333333, 480)
			.fill({
				color: 0x0,
				alpha: 0.01
			});

		this.fill = new Graphics()
			.rect(-106.666666667, 0, 853.333333333, 480)
			.fill({
				color: 0x0,
				alpha: 0
			});

		this.container.addChild(
			mask,
			this.fill,
			this.backgroundLayer,
			this.foregroundLayer,
			this.overlayLayer
		);

		this.container.boundsArea = new Rectangle(
			-106.666666667,
			0,
			853.333333333,
			480
		);
		this.container.mask = mask;

		this.remover = ConfigSection.createRemover(inject<BackgroundConfig>('config/background')?.onChange(
			'storyboard',
			(val) => {
				this.container.visible = val;
			}
		));
	}

	private textureMap = new Map<string, Texture>();
	async loadTextures() {
		const promises = [...this.resources].map(async ([key, resource]) => {
			if (
				// biome-ignore lint/style/noNonNullAssertion: Always have extension
				!['png', 'jpg', 'jpeg'].includes(key.split('.').at(-1)!.toLowerCase())
			) {
				return;
			}

			const url = URL.createObjectURL(resource!);
			try {
				const texture = await Assets.load<Texture>({
					// biome-ignore lint/style/noNonNullAssertion: Should be able to be found
					src: url,
					parser: 'texture'
				});

				this.textureMap.set(key.toLowerCase(), texture);
			} catch {
				console.warn(`Cannot load resource with name: ${key}`);
			} finally {
				URL.revokeObjectURL(url);
			}
		});

		await Promise.all(promises);
	}

	async loadMaster(raw: ArrayBuffer) {
		const { sprites, tree } = await this.load(raw);

		if (this._masterTree) {
			this._masterTree.clear();
			this._masterTree = undefined;
		}

		if (this.masterSprites) {
			for (const sprite of this.masterSprites) {
				// Destroy
				switch (sprite.layerType) {
					case StoryboardLayerType.background: {
						this.backgroundLayer.removeChild(sprite.container);
						break;
					}
					case StoryboardLayerType.foreground: {
						this.foregroundLayer.removeChild(sprite.container);
						break;
					}
					case StoryboardLayerType.overlay: {
						this.overlayLayer.removeChild(sprite.container);
						break;
					}
				}

				sprite.destroy();
			}

			this.masterSprites = [];
		}

		this.masterSprites = sprites;
		this._masterTree = tree;
	}

	async loadCurrent() {
		const raw = await this.blob.arrayBuffer();
		const { sprites, tree } = await this.load(raw);

		this.sprites = sprites;
		this._tree = tree;
	}

	update(timestamp: number) {
		if (!inject<BackgroundConfig>('config/background')?.storyboard || this.container.destroyed) return;
		this.fill.alpha = timestamp < this.startTime ? 0 : 1;

		const set = new Set<number>(
			this._tree?.search([timestamp - 1, timestamp + 1]) as Array<number>
		);
		const setMaster = new Set<number>(
			this._masterTree?.search([timestamp - 1, timestamp + 1]) as Array<number>
		);

		const disposed = this._previous.difference(set);
		const disposedMaster = this._previousMaster.difference(setMaster);

		for (const idx of disposed) {
			const sprite = this.sprites[idx];
			sprite.off();

			switch (sprite.layerType) {
				case StoryboardLayerType.background: {
					this.backgroundLayer.removeChild(sprite.container);
					break;
				}
				case StoryboardLayerType.foreground: {
					this.foregroundLayer.removeChild(sprite.container);
					break;
				}
				case StoryboardLayerType.overlay: {
					this.overlayLayer.removeChild(sprite.container);
					break;
				}
			}
		}

		for (const idx of disposedMaster) {
			const sprite = this.masterSprites[idx];
			sprite?.off();

			if (!sprite) continue;
			switch (sprite.layerType) {
				case StoryboardLayerType.background: {
					this.backgroundLayer.removeChild(sprite.container);
					break;
				}
				case StoryboardLayerType.foreground: {
					this.foregroundLayer.removeChild(sprite.container);
					break;
				}
				case StoryboardLayerType.overlay: {
					this.overlayLayer.removeChild(sprite.container);
					break;
				}
			}
		}

		const added = set.difference(this._previous);
		const addedMaster = setMaster.difference(this._previousMaster);

		this._previous = set;
		this._previousMaster = setMaster;

		const bgs = [];
		const fgs = [];
		const ovs = [];

		for (const idx of addedMaster) {
			const sprite = this.masterSprites[idx];
			if (!sprite) continue;

			switch (sprite.layerType) {
				case StoryboardLayerType.background: {
					bgs.push(sprite.container);
					break;
				}
				case StoryboardLayerType.foreground: {
					fgs.push(sprite.container);
					break;
				}
				case StoryboardLayerType.overlay: {
					ovs.push(sprite.container);
					break;
				}
			}
		}

		for (const idx of added) {
			const sprite = this.sprites[idx];

			switch (sprite.layerType) {
				case StoryboardLayerType.background: {
					bgs.push(sprite.container);
					break;
				}
				case StoryboardLayerType.foreground: {
					fgs.push(sprite.container);
					break;
				}
				case StoryboardLayerType.overlay: {
					ovs.push(sprite.container);
					break;
				}
			}
		}

		for (const idx of setMaster) {
			const sprite = this.masterSprites[idx];
			sprite?.update(timestamp);
		}

		for (const idx of set) {
			const sprite = this.sprites[idx];
			sprite.update(timestamp);
		}

		if (bgs.length > 0) this.backgroundLayer.addChild(...bgs);
		if (fgs.length > 0) this.foregroundLayer.addChild(...fgs);
		if (ovs.length > 0) this.overlayLayer.addChild(...ovs);
	}

	sortChildren() {
		const arr = [...this.masterSprites, ...this.sprites];
		for (let i = 0; i < arr.length; i++) {
			arr[i].container.zIndex = i;
		}
	}

	checkRemoveBG(set: BeatmapSet) {
		const hasBG = this.sprites.some(
			(sprite) =>
				sprite.data.path.replaceAll('\\', '/') ===
				set.backgroundKey
		);

		const context = new GraphicsContext()
			.rect(-106.666666667, 0, 853.333333333, 480)
			.fill({
				color: 0x0,
				alpha: hasBG ? 1 : 0
			});

		this.fill.context.destroy();
		this.fill.context = context;
	}

	destroy() {
		for (const sprite of this.masterSprites) {
			sprite.destroy();
		}

		for (const sprite of this.sprites) {
			sprite.destroy();
		}

		this.foregroundLayer.destroy(true);
		this.backgroundLayer.destroy(true);
		this.overlayLayer.destroy(true);
		this.container.destroy(true);

		this.remover();
	}

	private async load(raw: ArrayBuffer) {
		const decoder = new StoryboardDecoder();
		const data = decoder.decode(Buffer.from(raw).toString('utf8')).result;

		const sprites = await Promise.all([
			...[...(data.layers.Background?.elements ?? [])]
				.filter((element) => element instanceof StoryboardSpriteData)
				.map((element) => {
					const ele = (
						element instanceof StoryboardAnimationData
							? new StoryboardAnimation(element, StoryboardLayerType.background)
							: new StoryboardSprite(element, StoryboardLayerType.background)
					);
					ele.loadTexture(this.textureMap);

					return ele;
				}),
			...[...(data.layers.Foreground?.elements ?? [])]
				.filter((element) => element instanceof StoryboardSpriteData)
				.map((element) => {
					const ele = (
						element instanceof StoryboardAnimationData
							? new StoryboardAnimation(element, StoryboardLayerType.foreground)
							: new StoryboardSprite(element, StoryboardLayerType.foreground)
					);
					ele.loadTexture(this.textureMap);

					return ele;
				}),
			...[...(data.layers.Overlay?.elements ?? [])]
				.filter((element) => element instanceof StoryboardSpriteData)
				.map((element) => {
					const ele = (
						element instanceof StoryboardAnimationData
							? new StoryboardAnimation(element, StoryboardLayerType.overlay)
							: new StoryboardSprite(element, StoryboardLayerType.overlay)
					);
					ele.loadTexture(this.textureMap);

					return ele;
				})
		]);

		const s = sprites.map((sprite, idx) => {
			sprite.order = idx;
			return sprite;
		});

		const tree = new IntervalTree<number>();
		for (let i = 0; i < sprites.length; i++) {
			const { startTime, endTime } = sprites[i];
			if (startTime < this.startTime) this.startTime = startTime;
			tree.insert([startTime, endTime], i);
		}

		return {
			data,
			sprites: s,
			tree
		};
	}
}
