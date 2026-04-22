import DrawableSliderTail from '../../BeatmapSet/Beatmap/HitObjects/DrawableSliderTail.ts';
import Skin from '../Skin.ts';

export const update = (drawable: DrawableSliderTail, _: number) => {
	const baseTexture = drawable.skinManager
		?.getCurrentSkin()
		.getTexture(
			'sliderendcircle',
			drawable.context.consume<Skin>('beatmapSkin')
		);
	if (baseTexture) drawable.hitCircleSprite.texture = baseTexture;
};
