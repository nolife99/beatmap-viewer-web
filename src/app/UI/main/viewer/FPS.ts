import { LayoutContainer } from '@pixi/layout/components';
import pool from '@stdlib/array-pool';
import {
	Application,
	BitmapText,
	UPDATE_PRIORITY
} from 'pixi.js';
import { inject } from '../../../Context.ts';

const SAMPLE_COUNT = 16;
const SAMPLE_MASK = SAMPLE_COUNT - 1;

export default class FPS {
	public container = new LayoutContainer({
		layout: {
			position: 'absolute',
			bottom: 10,
			right: 10,
			padding: 8,
			width: 70,
			backgroundColor: [0, 0, 0, 0.7],
			borderRadius: 10,
			display: 'flex',
			flexDirection: 'column',
			alignItems: 'flex-end'
		}
	});

	private readonly fpsText: BitmapText;
	private readonly frameTimeText: BitmapText;
	private readonly poolMemoryText: BitmapText;

	private readonly app: Application;

	private lastFrame = performance.now();

	private readonly fpsSamples = new Float64Array(SAMPLE_COUNT);
	private readonly msSamples = new Float64Array(SAMPLE_COUNT);

	private fpsCursor = 0;
	private fpsCount = 0;

	private msCursor = 0;
	private msCount = 0;

	private frameData = {
		fps: 0,
		deltaMS: 0
	};

	private destroyed = false;

	constructor() {
		this.app = inject<Application>('ui/app')!;

		this.fpsText = new BitmapText({
			text: '0 fps',
			style: {
				fontFamily: 'Rubik',
				fontWeight: '400',
				fill: 0xffffff,
				fontSize: 12,
				align: 'right'
			},
			layout: {
				objectFit: 'none',
				objectPosition: 'center right'
			}
		});

		this.frameTimeText = new BitmapText({
			text: '0 ms',
			style: {
				fontFamily: 'Rubik',
				fontWeight: '400',
				fill: 0xffffff,
				fontSize: 12,
				align: 'right'
			},
			layout: {
				objectFit: 'none',
				objectPosition: 'center right'
			}
		});

		this.poolMemoryText = new BitmapText({
			text: '0 MB',
			style: {
				fontFamily: 'Rubik',
				fontWeight: '400',
				fill: 0xffffff,
				fontSize: 12,
				align: 'right'
			},
			layout: {
				objectFit: 'none',
				objectPosition: 'center right'
			}
		});

		this.container.addChild(
			this.fpsText,
			this.frameTimeText,
			this.poolMemoryText
		);

		this.app.ticker.remove(this.app.render, this.app);
		this.app.ticker.add(this.measuredRender, this, UPDATE_PRIORITY.LOW);
	}

	private measuredRender(): void {
		const frameStart = performance.now();

		const frameDelta = frameStart - this.lastFrame;
		this.lastFrame = frameStart;

		if (frameDelta > 0 && Number.isFinite(frameDelta)) {
			this.pushFpsSample(1000 / frameDelta);
			this.frameData.fps = this.weightedAverage(
				this.fpsSamples,
				this.fpsCursor,
				this.fpsCount
			);
		}

		const renderStart = performance.now();

		this.app.render();

		const renderMS = performance.now() - renderStart;

		this.pushMsSample(renderMS);
		this.frameData.deltaMS = this.weightedAverage(
			this.msSamples,
			this.msCursor,
			this.msCount
		);

		this.fpsText.text = `${this.frameData.fps.toFixed()} fps`;
		this.frameTimeText.text = `${this.frameData.deltaMS.toFixed(2)} ms`;
		this.poolMemoryText.text = `${
			(pool.nbytes / (1024 * 1024)).toFixed(2)
		} MB`;
	}

	private pushFpsSample(value: number): void {
		this.fpsSamples[this.fpsCursor] = value;
		this.fpsCursor = (this.fpsCursor + 1) & SAMPLE_MASK;

		if (this.fpsCount < SAMPLE_COUNT) {
			this.fpsCount++;
		}
	}

	private pushMsSample(value: number): void {
		this.msSamples[this.msCursor] = value;
		this.msCursor = (this.msCursor + 1) & SAMPLE_MASK;

		if (this.msCount < SAMPLE_COUNT) {
			this.msCount++;
		}
	}

	private weightedAverage(
		samples: Float64Array,
		cursor: number,
		count: number
	): number {
		if (count <= 0) return 0;

		let total = 0;
		let weightTotal = 0;

		const start = (cursor - count + SAMPLE_COUNT) & SAMPLE_MASK;

		for (let i = 0; i < count; i++) {
			const weight = i + 1;
			const index = (start + i) & SAMPLE_MASK;

			total += samples[index] * weight;
			weightTotal += weight;
		}

		return total / weightTotal;
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;

		this.app.ticker.remove(this.measuredRender, this);

		// Restore Pixi's default automatic render listener.
		this.app.ticker.add(this.app.render, this.app, UPDATE_PRIORITY.LOW);

		this.container.destroy({ children: true });
	}
}