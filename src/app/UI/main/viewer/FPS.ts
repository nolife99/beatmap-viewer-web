import { LayoutContainer } from "@pixi/layout/components";
import { inject } from "@/Context";
import { Application, BitmapText, type Renderer } from "pixi.js";
import pool from "@stdlib/array-pool";
import {debugPoolMemory} from "@/BeatmapSet/Beatmap/HitObjects/Rendering/CalculateSliderProgress.ts";

export default class FPS {
	public container = new LayoutContainer({
		layout: {
			position: "absolute",
			bottom: 10,
			right: 10,
			padding: 8,
			width: 70,
			backgroundColor: [0, 0, 0, 0.7],
			borderRadius: 10,
			display: "flex",
			flexDirection: "column",
			alignItems: "flex-end",
		},
	});

	private readonly fpsText: BitmapText;
	private readonly frameTimeText: BitmapText;
	private readonly poolMemoryText: BitmapText;

	private renderer: Renderer;
	private renderStart = 0;
	private lastFrame = 0;
	private fpsQueue: number[] = [];
	private msQueue: number[] = [];
	private frameData = { fps: 0, deltaMS: 0 };

	constructor() {
		this.renderer = inject<Application>("ui/app")!.renderer;
		this.fpsText = new BitmapText({
			text: "0 fps",
			style: {
				fontFamily: "Rubik",
				fontWeight: "400",
				fill: 0xffffff,
				fontSize: 12,
				align: "right",
			},
			layout: {
				objectFit: "none",
				objectPosition: "center right",
			},
		});

		this.frameTimeText = new BitmapText({
			text: "0 ms",
			style: {
				fontFamily: "Rubik",
				fontWeight: "400",
				fill: 0xffffff,
				fontSize: 12,
				align: "right",
			},
			layout: {
				objectFit: "none",
				objectPosition: "center right",
			},
		});

		this.poolMemoryText = new BitmapText({
			text: "0 MB",
			style: {
				fontFamily: "Rubik",
				fontWeight: "400",
				fill: 0xffffff,
				fontSize: 12,
				align: "right",
			},
			layout: {
				objectFit: "none",
				objectPosition: "center right",
			}
		});

		this.container.addChild(this.fpsText, this.frameTimeText, this.poolMemoryText);

		this.renderer.runners.prerender.add(this);
		this.renderer.runners.postrender.add(this);
	}

	prerender(): void {
		this.renderStart = performance.now();
		const fps = 1000 / (this.renderStart - this.lastFrame);
		this.fpsQueue.push(fps);

		while (this.fpsQueue.length >= 16) {
			this.fpsQueue.shift();
		}

		this.frameData.fps =
			this.fpsQueue.reduce((acc, curr, idx) => {
				return acc + curr * ((idx + 1) / this.fpsQueue.length);
			}, 0) /
			((1 / this.fpsQueue.length + 1) * (this.fpsQueue.length / 2));

		this.lastFrame = this.renderStart;
	}

	postrender(): void {
		const deltaMS = performance.now() - this.renderStart;
		this.msQueue.push(deltaMS);

		while (this.msQueue.length >= 16) {
			this.msQueue.shift();
		}

		this.frameData.deltaMS =
			this.msQueue.reduce((acc, curr, idx) => {
				return acc + curr * ((idx + 1) / this.msQueue.length);
			}, 0) /
			((1 / this.msQueue.length + 1) * (this.msQueue.length / 2));

		this.fpsText.text = `${this.frameData.fps.toFixed()} fps`;
		this.frameTimeText.text = `${this.frameData.deltaMS.toFixed(2)} ms`;
		this.poolMemoryText.text = `${((pool.nbytes + debugPoolMemory().bytes) / (1024 * 1024)).toFixed(2)} MB`;
	}

	destroy(): void {
		this.renderer.runners.prerender.remove(this);
		this.renderer.runners.postrender.remove(this);
		
		this.container.destroy({ children: true });
	}
}