import { LayoutContainer } from '@pixi/layout/components';
import { Color, type ColorSource, type FederatedPointerEvent, Graphics } from 'pixi.js';
import Audio from '../../../Audio/index.ts';
import BeatmapSet from '../../../BeatmapSet/index.ts';
import ColorConfig from '../../../Config/ColorConfig.ts';
import { inject } from '../../../Context.ts';

export default class ProgressBar {
	container = new LayoutContainer({
		layout: {
			flex: 1,
			height: '100%',
			backgroundColor: new Color(
				inject<ColorConfig>('config/color')?.color.crust
			).setAlpha(0.7),
			alignItems: 'center',
			justifyContent: 'center',
			paddingInline: 30
		}
	});

	line = new LayoutContainer({
		layout: {
			height: 4,
			width: '100%',
			backgroundColor: inject<ColorConfig>('config/color')?.color.surface0
		}
	});

	thumb = new Graphics({ x: 30, y: 30, roundPixels: true })
		.rect(-1, -30, 2, 60)
		.moveTo(-6, -30)
		.lineTo(-1, -26)
		.lineTo(1, -26)
		.lineTo(6, -30)
		.lineTo(-6, -30)
		.moveTo(-6, 30)
		.lineTo(-1, 26)
		.lineTo(1, 26)
		.lineTo(6, 30)
		.lineTo(-6, 30)
		.fill(inject<ColorConfig>('config/color')?.color.text);

	timeline: Graphics;
	isSeeking = false;

	constructor() {
		this.timeline = new Graphics({ interactive: false, x: 30, y: 20 });
		this.thumb.cacheAsTexture(true);

		this.container.addChild(this.line, this.thumb, this.timeline);

		this.container.on('layout', () => {
			this.thumb.y = (this.container.layout?.computedLayout.height ?? 0) / 2;
			this.timeline.y =
				(this.container.layout?.computedLayout.height ?? 0) / 2 - 10;
		});

		this.addEventHandler();

		inject<ColorConfig>('config/color')?.onChange(
			'color',
			({ crust, surface0, text }) => {
				this.container.layout = {
					backgroundColor: new Color(crust).setAlpha(0.7)
				};
				this.line.layout = { backgroundColor: surface0 };
				this.thumb
					.clear()
					.rect(-1, -30, 2, 60)
					.moveTo(-6, -30)
					.lineTo(-1, -26)
					.lineTo(1, -26)
					.lineTo(6, -30)
					.lineTo(-6, -30)
					.moveTo(-6, 30)
					.lineTo(-1, 26)
					.lineTo(1, 26)
					.lineTo(6, 30)
					.lineTo(-6, 30)
					.fill(text)
					.updateCacheTexture();
			}
		);
	}

	addEventHandler() {
		const seekByPercentage = (event: FederatedPointerEvent, smooth = false) => {
			const beatmapset = inject<BeatmapSet>('beatmapset');
			const audio = beatmapset?.context.consume<Audio>('audio');

			const percentage = this.getPercentage(event);

			if (beatmapset) {
				beatmapset._currentNextTick = percentage * (audio?.duration ?? 0);
			}

			if (!smooth) {
				beatmapset?._currentTween?.stop();
				beatmapset?.seek(percentage * (audio?.duration ?? 0));
			}
			if (smooth) {
				beatmapset?.smoothSeek(percentage * (audio?.duration ?? 0), 100);
			}
		};

		this.container.addEventListener('pointerdown', (event) => {
			this.isSeeking = true;
			seekByPercentage(event, true);
		});

		this.container.addEventListener('pointermove', (event) => {
			if (!this.isSeeking) return;
			seekByPercentage(event, false);
		});

		this.container.addEventListener('pointerup', () => {
			this.isSeeking = false;
		});

		this.container.addEventListener('pointerupoutside', () => {
			this.isSeeking = false;
		});
	}

	getPercentage(event: FederatedPointerEvent) {
		const { x } = event.getLocalPosition(this.container);
		const width = this.container.layout?.computedLayout.width;

		if (!width) return 0;
		return Math.min(1, Math.max(0, (x - 30) / (width - 60)));
	}

	setPercentage(percentage: number) {
		const width = (this.container.layout?.computedLayout.width ?? 60) - 60;
		if (!width) return;

		this.thumb.x = Math.round(
			30 + width * Math.min(1, Math.max(0, percentage))
		);
	}

	drawTimeline(
		points: ({
			position: number;
			color: ColorSource;
		} | null)[],
		kiai: {
			start: number;
			end: number;
		}[],
		breaks: {
			start: number;
			end: number;
		}[] = []
	) {
		this.container.once(
			'layout',
			() => this.drawTimeline(points, kiai, breaks)
		);
		if (!this.container.layout) {
			return;
		}

		this.timeline.clear();
		const width = (this.container.layout.computedLayout.width ?? 60) - 60;

		for (const { start, end } of kiai) {
			this.timeline.moveTo(start * width, 5).lineTo(end * width, 5);
		}
		this.timeline.stroke({ color: 0xffd978, alpha: 0.7, width: 2 });

		for (const { start, end } of breaks) {
			this.timeline.moveTo(start * width, 5).lineTo(end * width, 5);
		}
		this.timeline.stroke({ color: 0xffffff, alpha: 0.3, width: 2 });

		const pointsByColor = points.reduce((acc, point) => {
			if (!point) return acc;

			if (!acc.has(point.color)) {
				acc.set(point.color, []);
			}
			acc.get(point.color)!.push(point);

			return acc;
		}, new Map<ColorSource, { position: number; color: ColorSource }[]>());

		for (const [color, colorPoints] of pointsByColor) {
			for (const point of colorPoints) {
				this.timeline
					.moveTo(point.position * width, -6)
					.lineTo(point.position * width, 0);
			}
			this.timeline.stroke({ color, alpha: 0.7, width: 1 });
		}
		this.timeline.scale.y = 2;

		this.timeline.cacheAsTexture({ antialias: false, scaleMode: 'nearest' });
		this.container.addChild(this.line, this.timeline, this.thumb);
	}
}
