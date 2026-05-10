import { LayoutContainer } from '@pixi/layout/components';
import { Container, Text } from 'pixi.js';
import ColorConfig from '../../../Config/ColorConfig.ts';
import { inject, provide } from '../../../Context.ts';
import ResponsiveHandler from '../../../ResponsiveHandler.ts';
import { defaultStyle } from '../Metadata.ts';
import DifficultyGraph from './DifficultyGraph.ts';
import Spectrogram from './Spectrogram.ts';

export default class Modding {
	container: LayoutContainer;

	constructor() {
		this.container = new LayoutContainer({
			label: 'modding',
			layout: {
				width: 360,
				flexDirection: 'column',
				gap: 15,
				overflow: 'scroll',
				borderWidth: 1,
				borderColor: [0, 0, 0, 0],
				flex: 1
			}
		});

		const spectrogram = this.createEntry(
			'spectrogram',
			provide('ui/sidepanel/modding/spectrogram', new Spectrogram()).container
		);

		const difficultyGraph = this.createEntry(
			'difficulty graph',
			provide('ui/sidepanel/modding/difficulty', new DifficultyGraph()).container
		);

		this.container.addChild(spectrogram, difficultyGraph);

		inject<ResponsiveHandler>('responsiveHandler')?.on(
			'layout',
			(direction) => {
				switch (direction) {
					case 'landscape': {
						this.container.layout = {
							width: 360
						};
						break;
					}
					case 'portrait': {
						this.container.layout = {
							width: '100%'
						};
						break;
					}
				}
			}
		);
	}

	createEntry(label: string, children: Container) {
		const container = new Container({
			layout: {
				flexDirection: 'column',
				width: '100%',
				gap: 10,
				flexShrink: 0
			}
		});

		const text = new Text({
			text: label,
			style: {
				...defaultStyle,
				fontSize: 14,
				fontWeight: '300',
				fill: inject<ColorConfig>('config/color')?.color.subtext1
			},
			layout: {
				objectPosition: 'top left',
				objectFit: 'none',
				width: '100%',
				flexShrink: 0
			}
		});

		text.onRender = () => {
			text.style.fill = inject<ColorConfig>('config/color')?.color.subtext1 ?? 0xffffff;
		};

		container.addChild(text, children);

		return container;
	}
}
