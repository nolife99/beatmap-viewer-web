import { LayoutOptions } from '@pixi/layout';
import { LayoutContainer } from '@pixi/layout/components';
import { Tween } from '@tweenjs/tween.js';
import { Vector2 } from 'osu-classes';
import {
	Color,
	Container,
	Graphics,
	Rectangle,
	Sprite,
	type StrokeStyle,
	Text,
	type TextStyleOptions,
	Texture
} from 'pixi.js';
import Audio from '../../../../Audio/index.ts';
import DrawableHitCircle from '../../../../BeatmapSet/Beatmap/HitObjects/DrawableHitCircle.ts';
import DrawableSlider from '../../../../BeatmapSet/Beatmap/HitObjects/DrawableSlider.ts';
import Beatmap from '../../../../BeatmapSet/Beatmap/index.ts';
import BeatmapSet from '../../../../BeatmapSet/index.ts';
import BackgroundConfig from '../../../../Config/BackgroundConfig.ts';
import ColorConfig from '../../../../Config/ColorConfig.ts';
import ExperimentalConfig from '../../../../Config/ExperimentalConfig.ts';
import FullscreenConfig from '../../../../Config/FullscreenConfig.ts';
import GameplayConfig from '../../../../Config/GameplayConfig.ts';
import { inject, ScopedClass } from '../../../../Context.ts';
import { tweenGroup } from '../../../animation/AnimationController.ts';
import Easings from '../../../Easings.ts';
import Spinner from './Spinner.ts';

const defaultStyle: TextStyleOptions = {
	fontFamily: 'Rubik',
	fill: 0xbac2de,
	align: 'left',
	fontSize: 14,
	fontWeight: '400'
};

const defaultLayout: Omit<LayoutOptions, 'target'> = {
	objectPosition: 'top left',
	objectFit: 'none'
};

type Remover = () => void;

const makeRemover = (
	...removers: readonly (Remover | undefined | null)[]
): Remover => {
	let removed = false;
	let list: (Remover | undefined | null)[] | undefined = removers.slice();

	return () => {
		if (removed) return;
		removed = true;

		const current = list;
		list = undefined;

		if (!current) return;

		for (let i = current.length - 1; i >= 0; i--) {
			const remover = current[i];
			current[i] = undefined;

			try {
				remover?.();
			} catch (error) {
				console.error('[Gameplay] disposer failed', error);
			}
		}

		current.length = 0;
	};
};

export default class Gameplay extends ScopedClass {
	container: Container;
	wrapper: Container;
	grid: Graphics;
	background: LayoutContainer;
	objectsContainer: Container;
	selector: Graphics;
	selectContainer: Container;
	diffName!: Text;
	statsContainer!: LayoutContainer;
	closeButton!: LayoutContainer;
	spinner: Spinner;
	cursorLayer: Container;
	selected: Set<number> = new Set();
	dragWindow: [Vector2, Vector2] = [new Vector2(0, 0), new Vector2(0, 0)];

	private _currentTween?: Tween;
	private _destroyed = false;
	private _removeGlobalEventHandlers?: Remover;
	private _removeCloseButtonGlobalHandlers?: Remover;
	private _layoutTimeoutId: ReturnType<typeof setTimeout> | undefined;

	constructor(public beatmap: Beatmap) {
		super();

		this.container = new Container({
			layout: {
				position: 'absolute',
				width: 0,
				height: 0,
				alignItems: 'flex-start'
			},
			interactive: true
		});

		this.wrapper = new Container({
			layout: {
				width: '100%',
				height: '100%'
			},
			interactive: true
		});

		this.background = new LayoutContainer({
			layout: {
				width: '100%',
				height: '100%',
				backgroundColor: [
					0,
					0,
					0,
					Math.min(
						1,
						(inject<BackgroundConfig>('config/background')?.backgroundDim ??
							70) / 100
					)
				],
				borderRadius: 20
			}
		});

		this.selector = new Graphics()
			.rect(0, 0, 1, 1)
			.fill({ color: 0xffffff, alpha: 0.3 });

		this.objectsContainer = new Container({
			boundsArea: new Rectangle(0, 0, 512, 384),
			isRenderGroup: true
		});

		this.cursorLayer = new Container({
			boundsArea: new Rectangle(0, 0, 512, 384)
		});

		this.selectContainer = new Container({
			boundsArea: new Rectangle(0, 0, 512, 384)
		});

		this.spinner = new Spinner(this);
		this.spinner.spin = true;

		this.grid = new Graphics({
			interactive: false,
			eventMode: 'none',
			visible: inject<GameplayConfig>('config/gameplay')?.showGrid ?? true
		});

		this.createStats();
		this.createCloseButton();

		this.container.addChild(this.wrapper, this.spinner.graphics);
		this.wrapper.addChild(
			this.background,
			this.grid,
			this.objectsContainer,
			this.selectContainer,
			this.selector,
			this.cursorLayer
		);

		this.wrapper.on('layout', () => {
			if (!this._destroyed) this.reLayout();
		});

		this.loadEventListeners();
		this.loadGlobalEventHandlers();

		this.reLayout();
	}

	private static createRemover(
		...removers: readonly (Remover | undefined | null)[]
	): Remover {
		return makeRemover(...removers);
	}

	private loadGlobalEventHandlers() {
		const colorConfig = inject<ColorConfig>('config/color');
		const backgroundConfig = inject<BackgroundConfig>('config/background');
		const gameplayConfig = inject<GameplayConfig>('config/gameplay');

		this._removeGlobalEventHandlers = Gameplay.createRemover(
			this._removeCloseButtonGlobalHandlers,

			colorConfig?.onChange('color', ({ base, text }) => {
				if (this._destroyed) return;

				this.closeButton.layout = { backgroundColor: base };
				this.statsContainer.layout = { backgroundColor: base };
				this.diffName.style.fill = text;
			}),

			backgroundConfig?.onChange('backgroundDim', (value: number) => {
				if (this._destroyed) return;

				this.background.layout = {
					backgroundColor: [0, 0, 0, Math.max(0.01, value / 100)]
				};
			}),

			backgroundConfig?.onChange('breakSection', (isBreak: boolean) => {
				if (this._destroyed) return;

				this.stopCurrentTween();

				const tween = new Tween({
					value: this.background.alpha
				})
					.easing(Easings.Out)
					.to(
						{
							value: isBreak ? 0.6 : 1
						},
						1000
					)
					.onUpdate(({ value }) => {
						if (!this._destroyed) {
							this.background.alpha = value;
						}
					})
					.onComplete(() => {
						tweenGroup.remove(tween);

						if (this._currentTween === tween) {
							this._currentTween = undefined;
						}
					})
					.onStop(() => {
						tweenGroup.remove(tween);

						if (this._currentTween === tween) {
							this._currentTween = undefined;
						}
					})
					.start();

				tweenGroup.add(tween);
				this._currentTween = tween;
			}),

			gameplayConfig?.onChange('showGrid', (val: boolean) => {
				if (this._destroyed) return;

				this.grid.visible = val;
			})
		);

		this._removeCloseButtonGlobalHandlers = undefined;
	}

	private stopCurrentTween() {
		const tween = this._currentTween;
		if (!tween) return;

		this._currentTween = undefined;
		tween.stop();
		tweenGroup.remove(tween);
	}

	reLayout() {
		if (this._destroyed) return;

		const isFullscreen =
			inject<FullscreenConfig>('config/fullscreen')?.fullscreen;

		const shouldKeepScale =
			isFullscreen ||
			(this.context.consume<number>('clients') !== 1 &&
				!inject<ExperimentalConfig>('config/experimental')?.overlapGameplays);

		const width = this.wrapper.layout?.computedLayout.width ?? 0;
		const height = this.wrapper.layout?.computedLayout.height ?? 0;

		const scale = Math.min(width / 640, height / 480);
		const _w = 512 * scale;
		const _h = 384 * scale;

		this.objectsContainer.scale.set(scale);

		this.objectsContainer.x = (width - _w) / 2;
		this.objectsContainer.y = (height - _h) / 2;

		this.cursorLayer.scale.set(scale);
		this.cursorLayer.x = (width - _w) / 2;
		this.cursorLayer.y = (height - _h) / 2;

		this.grid.x = (width - _w) / 2;
		this.grid.y = (height - _h) / 2;

		if (this._layoutTimeoutId !== undefined) {
			clearTimeout(this._layoutTimeoutId);
			this._layoutTimeoutId = undefined;
		}

		this._layoutTimeoutId = setTimeout(() => {
			this._layoutTimeoutId = undefined;

			if (!this._destroyed) {
				this.drawGrid(_w);
			}
		});

		this.selectContainer.scale.set(scale);

		this.selectContainer.x = (width - _w) / 2;
		this.selectContainer.y = (height - _h) / 2;

		this.spinner.graphics.x = width / 2;
		this.spinner.graphics.y = height / 2;

		this.wrapper.scale.set(shouldKeepScale ? 1 : 0.98 / 0.8);
	}

	drawGrid(width = 512) {
		if (this._destroyed) return;

		const scale = width / 512;
		const height = 384 * scale;
		const unit = 32 * scale;
		const halfUnit = unit / 2;
		const cornerRadius = 8 * scale;
		const color = new Color([1, 1, 1, 0.5]);

		this.grid.clear();
		this.grid.roundRect(0, 0, width, height, cornerRadius)
			.stroke({ color, width: 2, alignment: 0.5 });

		for (let i = unit; i < width - 1; i += unit) {
			this.grid.rect(i - 0.5, 0, 1, height).fill(color);
		}

		for (let i = unit; i < height - 1; i += unit) {
			this.grid.rect(0, i - 0.5, width, 1).fill(color);
		}

		this.grid.rect(width / 2 - 0.5, 0, 1, height).fill(color);
		this.grid.rect(0, height / 2 - 0.5, 1, height).fill(color);

		const cornerStroke: StrokeStyle = {
			color,
			width: 4,
			alignment: 0.5,
			cap: 'round',
			join: 'round'
		};

		this.grid
			.moveTo(0, halfUnit).lineTo(0, cornerRadius)
			.arc(cornerRadius, cornerRadius, cornerRadius, Math.PI, -Math.PI / 2)
			.lineTo(halfUnit, 0).stroke(cornerStroke)

			.moveTo(width - halfUnit, 0).lineTo(width - cornerRadius, 0)
			.arc(width - cornerRadius, cornerRadius, cornerRadius, -Math.PI / 2, 0)
			.lineTo(width, halfUnit).stroke(cornerStroke)

			.moveTo(width, height - halfUnit).lineTo(width, height - cornerRadius)
			.arc(width - cornerRadius, height - cornerRadius, cornerRadius, 0, Math.PI / 2)
			.lineTo(width - halfUnit, height).stroke(cornerStroke)

			.moveTo(halfUnit, height).lineTo(cornerRadius, height)
			.arc(cornerRadius, height - cornerRadius, cornerRadius, Math.PI / 2, Math.PI)
			.lineTo(0, height - halfUnit).stroke(cornerStroke)

			.cacheAsTexture(true);
	}

	loadEventListeners() {
		const beatmap = this.beatmap;
		let clicked = false;

		const resetDrag = () => {
			clicked = false;
			this.dragWindow[0].x = 0;
			this.dragWindow[0].y = 0;
			this.dragWindow[1].x = 0;
			this.dragWindow[1].y = 0;
		};

		const getAudioTime = () =>
			inject<BeatmapSet>('beatmapset')?.context.consume<Audio>('audio')
				?.currentTime ?? 0;

		this.wrapper.on('pointerup', () => {
			if (this._destroyed) return;

			resetDrag();
		});

		this.wrapper.on('pointerupoutside', () => {
			if (this._destroyed) return;

			resetDrag();
		});

		this.wrapper.on('globalpointermove', (event) => {
			if (this._destroyed) return;

			const pos = this.objectsContainer.toLocal(event.global);

			if (clicked) {
				this.dragWindow[1].x = event.global.x;
				this.dragWindow[1].y = event.global.y;
			}

			const p = new Vector2(pos.x, pos.y);
			const time = getAudioTime();

			for (const idx of beatmap.previousObjects) {
				const obj = beatmap.objects[idx];

				if (obj instanceof DrawableHitCircle || obj instanceof DrawableSlider) {
					const collided = obj.checkCollide([p, p], time);

					if (obj instanceof DrawableSlider) {
						obj.isHover = collided;
					}
				}
			}
		});

		this.wrapper.on('pointerdown', (event) => {
			if (this._destroyed) return;

			clicked = true;
			this.dragWindow[0].x = event.global.x;
			this.dragWindow[0].y = event.global.y;
			this.dragWindow[1].x = event.global.x;
			this.dragWindow[1].y = event.global.y;

			const pos = this.objectsContainer.toLocal(event.global);
			const p = new Vector2(pos.x, pos.y);
			const selected: number[] = [];
			const time = getAudioTime();

			for (const idx of beatmap.previousObjects) {
				const obj = beatmap.objects[idx];

				if (obj instanceof DrawableHitCircle || obj instanceof DrawableSlider) {
					if (obj.checkCollide([p, p], time)) {
						selected.push(idx);
					}
				}
			}

			if (!event.ctrlKey || selected.length === 0) {
				for (const select of this.selected) {
					this.removeSelected(select);
				}
			}

			if (selected.length !== 0) {
				this.selected.add(selected[0]);
			}

			for (const select of this.selected) {
				this.addSelected(select);
			}
		});
	}

	addSelected(idx: number) {
		if (this._destroyed) return;

		this.selected.add(idx);

		const obj = this.beatmap.objects[idx] as DrawableHitCircle | DrawableSlider;
		if (obj.timelineObject) obj.timelineObject.isSelected = true;

		this.selectContainer.addChild(obj.select);
		obj.isSelected = true;
	}

	removeSelected(idx: number) {
		if (this._destroyed) return;

		this.selected.delete(idx);

		const obj = this.beatmap.objects[idx] as DrawableHitCircle | DrawableSlider;
		obj.isSelected = false;

		if (obj.timelineObject) obj.timelineObject.isSelected = false;

		if (obj.select.parent === this.selectContainer) {
			this.selectContainer.removeChild(obj.select);
		}
	}

	private clearSelectionState() {
		const beatmap = this.beatmap;
		if (!beatmap) {
			this.selected.clear();
			return;
		}

		for (const idx of this.selected) {
			const obj = beatmap.objects[idx];

			if (obj instanceof DrawableHitCircle || obj instanceof DrawableSlider) {
				obj.isSelected = false;

				if (obj.timelineObject) {
					obj.timelineObject.isSelected = false;
				}

				if (obj.select.parent === this.selectContainer) {
					this.selectContainer.removeChild(obj.select);
				}
			}
		}

		this.selected.clear();
	}

	checkInBound(point: Vector2) {
		const start = this.objectsContainer.toLocal(this.dragWindow[0]);
		const end = this.objectsContainer.toLocal(this.dragWindow[1]);

		const minX = Math.min(start.x, end.x);
		const maxX = Math.max(start.x, end.x);
		const minY = Math.min(start.y, end.y);
		const maxY = Math.max(start.y, end.y);

		return (
			minX <= point.x && point.x <= maxX && minY <= point.y && point.y <= maxY
		);
	}

	showCloseButton() {
		if (this._destroyed) return;

		this.container.addChild(this.closeButton);
	}

	hideCloseButton() {
		if (this._destroyed) return;

		this.container.removeChild(this.closeButton);
	}

	showDiffName(withCloseButton: boolean = false) {
		if (this._destroyed) return;

		if (withCloseButton) {
			this.statsContainer.addChild(this.closeButton);
		} else {
			this.statsContainer.removeChild(this.closeButton);
		}

		this.container.addChild(this.statsContainer);
	}

	hideDiffName() {
		if (this._destroyed) return;

		this.container.removeChild(this.statsContainer);
	}

	createCloseButton() {
		const closeButtonContainer = new LayoutContainer({
			layout: {
				width: 20,
				height: 20,
				alignItems: 'center',
				justifyContent: 'center',
				backgroundColor: inject<ColorConfig>('config/color')?.color.base,
				borderRadius: 15
			}
		});

		const closeButton = new Sprite({
			width: 20,
			height: 20,
			layout: {
				width: 20,
				height: 20
			}
		});

		closeButton.tint =
			inject<ColorConfig>('config/color')?.color.text ?? 0xffffff;

		const colorConfig = inject<ColorConfig>('config/color');

		this._removeCloseButtonGlobalHandlers = Gameplay.createRemover(
			colorConfig?.onChange('color', ({ text }) => {
				if (!this._destroyed) {
					closeButton.tint = text;
				}
			})
		);

		closeButton.texture = Texture.from('x.png');

		closeButtonContainer.cursor = 'pointer';

		const unloadSelf = () => {
			if (this._destroyed) return;

			closeButtonContainer.layout = {
				backgroundColor:
					inject<ColorConfig>('config/color')?.color.base ?? 0xffffff
			};

			const bms = this.beatmap.context.consume<BeatmapSet>('beatmapset');
			if (!bms) return;

			const idx = bms.difficulties.indexOf(this.beatmap);
			bms.unloadSlave(idx);
		};

		closeButtonContainer.addEventListener('pointertap', unloadSelf);

		closeButtonContainer.addEventListener('pointerenter', () => {
			if (this._destroyed) return;

			closeButtonContainer.layout = {
				backgroundColor:
					inject<ColorConfig>('config/color')?.color.surface2 ?? 0xffffff
			};
		});

		closeButtonContainer.addEventListener('pointerleave', () => {
			if (this._destroyed) return;

			closeButtonContainer.layout = {
				backgroundColor:
					inject<ColorConfig>('config/color')?.color.base ?? 0xffffff
			};
		});

		closeButtonContainer.addChild(closeButton);
		this.closeButton = closeButtonContainer;
	}

	createStats() {
		this.statsContainer = new LayoutContainer({
			label: 'stats',
			layout: {
				display: 'flex',
				alignItems: 'center',
				flexDirection: 'row',
				gap: 10,
				backgroundColor: inject<ColorConfig>('config/color')?.color.base,
				borderRadius: 20,
				padding: 10,
				paddingInline: 20,
				flex: 0,
				height: 'auto',
				position: 'absolute',
				top: 20,
				left: 20,
				transformOrigin: 'top left'
			}
		});

		this.diffName = new Text({
			text: this.beatmap.data.metadata.version,
			style: {
				...defaultStyle,
				fill: inject<ColorConfig>('config/color')?.color.text
			},
			layout: defaultLayout
		});

		this.statsContainer.addChild(this.diffName);
	}

	override destroy() {
		if (this._destroyed) return;
		this._destroyed = true;

		if (this._layoutTimeoutId !== undefined) {
			clearTimeout(this._layoutTimeoutId);
			this._layoutTimeoutId = undefined;
		}

		this.stopCurrentTween();

		this._removeGlobalEventHandlers?.();
		this._removeGlobalEventHandlers = undefined;
		this._removeCloseButtonGlobalHandlers = undefined;

		this.clearSelectionState();

		// Pixi destroys its own internal event handlers/listeners for this tree.
		this.container.destroy({ children: true });

		// Your current Context class has no public destroy(), so clear it defensively.
		const context = this.context as unknown as {
			destroy?: () => void;
			_map?: { clear?: () => void };
			parent?: undefined;
		};

		context.destroy?.();
		context._map?.clear?.();
		context.parent = undefined;

		this.selected.clear();

		// Break the largest strong edge when this Gameplay instance itself is retained.
		this.beatmap = undefined as unknown as Beatmap;
		super.destroy();
	}
}