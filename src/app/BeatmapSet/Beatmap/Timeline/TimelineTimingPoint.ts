import { TimingPoint } from 'osu-classes';
import { BitmapText, Container, Sprite } from 'pixi.js';
import TimelineConfig from '../../../Config/TimelineConfig.ts';
import { inject } from '../../../Context.ts';
import { DEFAULT_SCALE } from '../../../UI/main/viewer/Timeline/index.ts';
import { getPixelTexture } from './TimelineSlider.ts';

export default class TimelineTimingPoint {
	container: Container = new Container();

	private readonly timelineConfig = inject<TimelineConfig>('config/timeline');

	private readonly background = new Sprite(getPixelTexture());
	private readonly line = new Sprite(getPixelTexture());
	private readonly text: BitmapText;

	constructor(public data: TimingPoint) {
		this.text = new BitmapText({
			text: `${data.bpm.toFixed(0)}BPM`,
			style: {
				fontFamily: 'Rubik',
				align: 'center',
				fill: 0xffffff,
				fontSize: 10
			},
			anchor: {
				x: 0,
				y: 1
			},
			x: 5,
			y: 38
		});

		const width = this.text.width;
		const height = this.text.height;

		this.background.tint = 0xf54254;
		this.background.x = 0;
		this.background.y = 40 - (height + 4);
		this.background.width = width + 10;
		this.background.height = height + 4;

		this.line.tint = 0xffffff;
		this.line.x = -1;
		this.line.y = -40;
		this.line.width = 2;
		this.line.height = 80;

		this.container.addChild(
			this.background,
			this.line,
			this.text
		);

		this.container.y = 40;

		this.container.onRender = () => {
			const scale = this.timelineConfig?.scale ?? 1;
			this.container.x = this.data.startTime / (DEFAULT_SCALE / scale);
		};
	}

	destroy() {
		this.container.destroy({ children: true });
	}
}