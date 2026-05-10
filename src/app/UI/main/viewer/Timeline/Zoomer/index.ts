import FullscreenConfig from '../../../../../Config/FullscreenConfig.ts';
import TimelineConfig from '../../../../../Config/TimelineConfig.ts';
import { inject } from '../../../../../Context.ts';
import ZContainer from '../../../../core/ZContainer.ts';
import Button from './Button.ts';

export default class Zoomer {
	container = new ZContainer({
		label: 'zoomer',
		layout: {
			height: 80,
			width: 40,
			flexDirection: 'column'
		}
	});

	constructor() {
		const zoomIn = new Button('plus.png', () => {
			const timeline = inject<TimelineConfig>('config/timeline');

			if (!timeline) return;
			timeline.scale = Math.min(1.5, timeline.scale + 0.1);
		});
		const zoomOut = new Button('minus.png', () => {
			const timeline = inject<TimelineConfig>('config/timeline');

			if (!timeline) return;
			timeline.scale = Math.max(0.1, timeline.scale - 0.1);
		});

		this.container.addChild(zoomIn.container, zoomOut.container);

		inject<FullscreenConfig>('config/fullscreen')?.onChange(
			'fullscreen',
			(isFullscreen) => {
				if (isFullscreen) {
					this.container.renderable = false;
				}

				if (!isFullscreen) {
					this.container.renderable = true;
				}
			}
		);
	}
}
