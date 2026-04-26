import { LayoutContainer } from '@pixi/layout/components';
import { BitmapText, Color } from 'pixi.js';
import ColorConfig from '../../../Config/ColorConfig.ts';
import { inject } from '../../../Context.ts';
import ResponsiveHandler from '../../../ResponsiveHandler.ts';

export default class Timestamp {
	container: LayoutContainer = new LayoutContainer({
		layout: {
			width: 150,
			height: '100%',
			backgroundColor: new Color(
				inject<ColorConfig>('config/color')?.color.base
			).setAlpha(0.7),
			flexShrink: 0,
			flexDirection: 'column',
			alignItems: 'center',
			justifyContent: 'center',
			gap: 2
		}
	});

	timestampText = new BitmapText({
		text: '00:00:000',
		label: 'timestamp-text',
		style: {
			fontFamily: 'Rubik',
			fontSize: 15,
			fontWeight: '400',
			fill: inject<ColorConfig>('config/color')?.color.text,
			align: 'center'
		},
		layout: {
			width: 74,
			objectFit: 'none',
			objectPosition: 'center'
		}
	});

	timingContainer = new LayoutContainer({
		layout: {
			gap: 5,
			alignItems: 'baseline'
		}
	});

	bpm = new BitmapText({
		text: '0BPM',
		style: {
			fontFamily: 'Rubik',
			fontSize: 12,
			fontWeight: '500',
			fill: inject<ColorConfig>('config/color')?.color.text,
			align: 'center'
		},
		layout: {
			objectFit: 'none',
			objectPosition: 'center'
		}
	});

	sliderVelocity = new BitmapText({
		text: 'x0.00',
		style: {
			fontFamily: 'Rubik',
			fontSize: 10,
			fontWeight: '400',
			fill: inject<ColorConfig>('config/color')?.color.text,
			align: 'center'
		},
		layout: {
			objectFit: 'none',
			objectPosition: 'center'
		}
	});

	private lastTimestampMs = -1;

	constructor() {
		this.timingContainer.addChild(this.bpm, this.sliderVelocity);
		this.container.addChild(this.timestampText, this.timingContainer);

		inject<ColorConfig>('config/color')?.onChange('color', ({ base, text }) => {
			this.container.layout = {
				backgroundColor: new Color(base).setAlpha(0.7)
			};

			this.timestampText.style.fill = text;
			this.bpm.style.fill = text;
			this.sliderVelocity.style.fill = text;
		});

		inject<ResponsiveHandler>('responsiveHandler')?.on(
			'layout',
			(direction) => {
				switch (direction) {
					case 'landscape': {
						this.container.layout = { width: 150, height: '100%' };
						break;
					}
					case 'portrait': {
						this.container.layout = { width: '100%', height: 60 };
						break;
					}
				}
			}
		);
	}

	updateDigit(timestamp: number) {
		const totalMs = Math.max(0, Math.floor(timestamp));

		if (totalMs === this.lastTimestampMs) {
			return;
		}

		this.lastTimestampMs = totalMs;

		const minutes = Math.floor(totalMs / 60000) % 100;
		const seconds = Math.floor(totalMs / 1000) % 60;
		const milliseconds = totalMs % 1000;

		this.timestampText.text =
			`${minutes.toString().padStart(2, '0')}:` +
			`${seconds.toString().padStart(2, '0')}:` +
			milliseconds.toString().padStart(3, '0');
	}

	updateBPM(bpm: number) {
		this.bpm.text = this.bpm.label = `${bpm.toFixed(0)}BPM`;
	}

	updateSliderVelocity(sv: number) {
		this.sliderVelocity.text = this.sliderVelocity.label = `x${sv.toFixed(2)}`;
	}
}