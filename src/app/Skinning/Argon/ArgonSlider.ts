import { Color } from 'pixi.js';
import DrawableSlider from '../../BeatmapSet/Beatmap/HitObjects/DrawableSlider.ts';
import Beatmap from '../../BeatmapSet/Beatmap/index.ts';
import ExperimentalConfig from '../../Config/ExperimentalConfig.ts';
import SkinningConfig from '../../Config/SkinningConfig.ts';
import { inject } from '../../Context.ts';
import Gameplays from '../../UI/main/viewer/Gameplay/Gameplays.ts';
import { darken } from '../../utils.ts';

export const refreshColor = (drawable: DrawableSlider) => {
	const skin = drawable.skinManager?.getCurrentSkin();
	if (!skin) return;

	const beatmap = drawable.context.consume<Beatmap>('beatmapObject');
	const tintByDiff =
		(inject<Gameplays>('ui/main/viewer/gameplays')?.gameplays.size ?? 1) - 1 &&
		inject<ExperimentalConfig>('config/experimental')?.overlapGameplays &&
		beatmap?.randomColor;

	const comboIndex = drawable.object.comboIndexWithOffsets %
		(beatmap?.data.colors.comboColors.length &&
		!inject<SkinningConfig>('config/skinning')?.disableBeatmapSkin
			? beatmap?.data.colors.comboColors.length
			: skin.colorsLength);
	const colors = beatmap?.data.colors.comboColors;
	const comboColor = colors?.length &&
	!inject<SkinningConfig>('config/skinning')?.disableBeatmapSkin
		? `${colors[comboIndex].red},${colors[comboIndex].green},${
			colors[comboIndex].blue
		}`
		: (skin.config
				.Colours[`Combo${comboIndex + 1}` as keyof typeof skin.config.Colours] ??
			skin.config.Colours.Combo1);

	const color =
		(tintByDiff
			? new Color(beatmap.randomColor).toUint8RgbArray().join(',')
			: comboColor).split(',').map((value) => +value / 255);
	drawable.trackColor = color;
	drawable.color = new Color(color);

	drawable.borderColor = color;

	drawable.updateBodyUniforms({
		borderColor: color,
		innerColor: darken([color[0], color[1], color[2]], 4.0),
		outerColor: darken([color[0], color[1], color[2]], 4.0),
		borderWidth: 0.128 * 1.65,
		bodyAlpha: 0.92
	});
	drawable.updateSelectionUniforms({
		borderColor: [255 / 255, 192 / 255, 43 / 255],
		borderWidth: 0.128 * 1.65
	});
};
