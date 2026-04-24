import { LayoutContainer } from '@pixi/layout/components';
import BackgroundConfig from '../../../Config/BackgroundConfig.ts';
import FullscreenConfig from '../../../Config/FullscreenConfig.ts';
import { inject, provide } from '../../../Context.ts';
import ResponsiveHandler from '../../../ResponsiveHandler.ts';
import { Clamp } from '../../../utils.ts';
import Controls from '../controls/index.ts';
import Background from './Background.ts';
import Gameplays from './Gameplay/Gameplays.ts';
import Beatsnap from './Timeline/Beatsnap/index.ts';
import Timeline from './Timeline/index.ts';
import Zoomer from './Timeline/Zoomer/index.ts';

export default class Viewer {
	container = new LayoutContainer({
		label: 'viewer',
		layout: {
			width: '100%',
			flex: 1,
			flexDirection: 'column',
			backgroundColor: [0, 0, 0, 0.2],
			borderRadius: 20,
			overflow: 'hidden'
		},
		interactive: true
	});

	constructor(controls: Controls) {
		const timeline = provide('ui/main/viewer/timeline', new Timeline());
		const zoomer = provide('ui/main/viewer/zoomer', new Zoomer());
		const beatsnap = provide('ui/main/viewer/beatsnap', new Beatsnap());
		const gameplays = provide('ui/main/viewer/gameplays', new Gameplays());
		const background = provide('ui/main/viewer/background', new Background());

		const wrapper = new LayoutContainer({
			layout: {
				width: '100%',
				height: 80,
				backgroundColor: {
					r: 0,
					g: 0,
					b: 0,
					a: Clamp(
						(inject<BackgroundConfig>('config/background')?.backgroundDim ??
							80) /
						100 +
						0.1,
						0,
						1
					)
				}
			},
			zIndex: 2
		});

		wrapper.addChild(timeline.container, zoomer.container, beatsnap.container);

		this.container.addChild(
			background.container,
			wrapper,
			gameplays.container,
			controls.container
		);

		inject<FullscreenConfig>('config/fullscreen')?.onChange(
			'fullscreen',
			(isFullscreen) => {
				const direction = inject<ResponsiveHandler>('responsiveHandler')
					?.direction;
				this.container.layout = {
					borderRadius: isFullscreen || direction === 'portrait' ? 0 : 20
				};

				wrapper.layout = {
					height: isFullscreen ? (direction === 'portrait' ? 80 : 0) : 80
				};
			}
		);

		inject<ResponsiveHandler>('responsiveHandler')?.on(
			'layout',
			(direction) => {
				const isFullscreen = inject<FullscreenConfig>('config/fullscreen')
					?.fullscreen;
				switch (direction) {
					case 'landscape': {
						this.container.layout = {
							borderRadius: isFullscreen ? 0 : 20,
							flex: 1,
							aspectRatio: undefined
						};
						break;
					}
					case 'portrait': {
						this.container.layout = {
							flex: undefined,
							borderRadius: 0
							// aspectRatio: 4 / 3,
						};
						break;
					}
				}

				wrapper.layout = {
					height: isFullscreen ? (direction === 'portrait' ? 80 : 0) : 80
				};
			}
		);

		inject<BackgroundConfig>('config/background')?.onChange(
			'backgroundDim',
			(val) => {
				wrapper.layout = {
					backgroundColor: {
						r: 0,
						g: 0,
						b: 0,
						a: Clamp(val / 100 + 0.1, 0, 1)
					}
				};
			}
		);
	}
}
