import { LayoutContainer } from '@pixi/layout/components';
import { Color, Sprite, Texture } from 'pixi.js';
import Audio from '../../../Audio/index.ts';
import BeatmapSet from '../../../BeatmapSet/index.ts';
import ColorConfig from '../../../Config/ColorConfig.ts';
import { inject } from '../../../Context.ts';

export default class Play {
	container = new LayoutContainer({
		label: 'play',
		layout: {
			aspectRatio: 1,
			backgroundColor: new Color(
				inject<ColorConfig>('config/color')?.color.crust
			).setAlpha(0.7),
			height: '100%',
			flexShrink: 0,
			alignItems: 'center',
			justifyContent: 'center'
		}
	});

	sprite = new Sprite();

	constructor() {
		this.sprite.texture = Texture.from('play.png');
		this.sprite.width = 20;
		this.sprite.height = 20;
		this.sprite.layout = {
			width: 20,
			height: 20
		};
		this.sprite.tint = inject<ColorConfig>('config/color')?.color.text ??
			0xffffff;
		this.container.addChild(this.sprite);

		inject<ColorConfig>('config/color')?.onChange(
			'color',
			({ crust, text }) => {
				this.container.layout = {
					backgroundColor: new Color(crust).setAlpha(0.7)
				};
				this.sprite.tint = text;
			}
		);

		this.container.cursor = 'pointer';

		this.container.addEventListener('pointertap', (event) => {
			const audio = inject<BeatmapSet>('beatmapset')?.context.consume<Audio>(
				'audio'
			);
			if (!audio) return;

			inject<BeatmapSet>('beatmapset')?.toggle(event);
		});

		this.container.addEventListener('pointerenter', () => {
			this.container.layout = {
				backgroundColor: new Color(
					inject<ColorConfig>('config/color')?.color.surface2 ?? 0xffffff
				).setAlpha(0.7)
			};
		});

		this.container.addEventListener('pointerleave', () => {
			this.container.layout = {
				backgroundColor: new Color(
					inject<ColorConfig>('config/color')?.color.crust ?? 0xffffff
				).setAlpha(0.7)
			};
		});
	}
}
