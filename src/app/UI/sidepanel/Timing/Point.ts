import { ControlPoint, ControlPointType, DifficultyPoint, type SamplePoint, TimingPoint } from 'osu-classes';
import { type ColorSource, Container, Graphics, BitmapText } from 'pixi.js';
import ColorConfig from '../../../Config/ColorConfig.ts';
import { inject } from '../../../Context.ts';
import { millisecondsToMinutesString } from '../../../utils.ts';

export default class Point {
	container: Container;
	private indicator: Graphics;
	private timestamp: BitmapText;
	private content1: BitmapText;
	private content2: BitmapText;
	private color: Graphics;

	private accent: ColorSource;
	private bg = inject<ColorConfig>('config/color')?.color.mantle ?? 0x181825;
	private _destroyed = false;

	constructor(public data: ControlPoint) {
		this.accent = data.pointType === ControlPointType.TimingPoint
			? 0xf38ba8
			: data.pointType === ControlPointType.DifficultyPoint
				? 0xa6e3a1
				: (inject<ColorConfig>('config/color')?.color.text ?? 0xcdd6f4);

		this.color = new Graphics().roundRect(0, 0, 360, 40, 10).fill(0xffffff);
		this.color.tint = this.bg;

		this.container = new Container({
			width: 360,
			height: 40,
			alpha: 0.5,
			visible: false,
			interactiveChildren: false
		});

		this.container.onRender = () => {
			if (this._destroyed) return;

			this.bg = inject<ColorConfig>('config/color')?.color.mantle ?? 0xffffff;
			this.accent = data.pointType === ControlPointType.TimingPoint
				? 0xf38ba8
				: data.pointType === ControlPointType.DifficultyPoint
					? 0xa6e3a1
					: (inject<ColorConfig>('config/color')?.color.text ?? 0xcdd6f4);

			if (this.indicator.visible) this.select();
			if (!this.indicator.visible) this.unselect();
		};

		this.timestamp = new BitmapText({
			text: millisecondsToMinutesString(data.startTime),
			style: {
				fontSize: 14,
				fontFamily: 'Rubik',
				fill: this.accent,
				align: 'left'
			},
			layout: false
		});

		this.content1 = new BitmapText({
			text: data.pointType === ControlPointType.TimingPoint
				? `${Math.round((data as TimingPoint).bpm)} BPM`
				: data.pointType === ControlPointType.DifficultyPoint
					? `x${(data as DifficultyPoint).sliderVelocity.toFixed(2)}`
					: `${(data as SamplePoint).sampleSet}: ${
						(data as SamplePoint).customIndex === 0
							? 'Default'
							: `Custom ${(data as SamplePoint).customIndex}`
					}`,
			style: {
				fontSize: 14,
				fontFamily: 'Rubik',
				fill: this.accent,
				align: 'left',
				fontWeight: '500'
			},
			layout: false,
			x: 80
		});

		this.content2 = new BitmapText({
			text: data.pointType === ControlPointType.TimingPoint
				? `Signature ${(data as TimingPoint).timeSignature}/4`
				: data.pointType === ControlPointType.DifficultyPoint
					? ''
					: `Volume ${(data as SamplePoint).volume}%`,
			style: {
				fontSize: 14,
				fontFamily: 'Rubik',
				fill: this.accent,
				align: 'left'
			},
			layout: false
		});

		this.indicator = new Graphics({
			tint: this.accent,
			x: 10,
			y: 15,
			visible: false
		})
			.moveTo(0, 0)
			.lineTo(0, 10)
			.lineTo(5, 5)
			.lineTo(0, 0)
			.fill(0xffffff);

		this.indicator.cacheAsTexture(true);

		this.container.addChild(
			this.color,
			this.timestamp,
			this.content1,
			this.content2,
			this.indicator
		);

		this.reWidth(360);
	}

	reWidth(width: number, height = 40) {
		this.color.clear().roundRect(0, 0, width, 40, 10).fill(0xffffff);

		this.content2.x = width - this.content2.width - 20;
		this.content2.y = (height - this.content2.height) / 2;

		this.timestamp.x = 20;
		this.timestamp.y = (height - this.timestamp.height) / 2;

		this.content1.x = 20 + 80;
		this.content1.y = (height - this.content1.height) / 2;
	}

	on() {
		if (this.container.visible === true) {
			return;
		}

		this.container.visible = true;
		this.container.layout?.forceUpdate();
	}

	off() {
		if (this.container.visible === false) {
			return;
		}

		this.container.visible = false;
	}

	select() {
		this.container.alpha = 1;

		this.color.tint = this.accent;
		this.timestamp.style.fill = this.bg;
		this.content1.style.fill = this.bg;
		this.content2.style.fill = this.bg;
		this.indicator.tint = this.bg;

		this.indicator.visible = true;
	}

	unselect() {
		this.container.alpha = 0.5;

		this.color.tint = this.bg;
		this.timestamp.style.fill = this.accent;
		this.content1.style.fill = this.accent;
		this.content2.style.fill = this.accent;
		this.indicator.tint = this.accent;

		this.indicator.visible = false;
	}

	destroy() {
		this.container.destroy();
		this.color.destroy();
		this.timestamp.destroy();
		this.content1.destroy();
		this.content2.destroy();
		this.indicator.destroy();

		this._destroyed = true;
	}
}
