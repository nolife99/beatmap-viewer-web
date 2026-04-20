import type Beatmap from '../../BeatmapSet/Beatmap/index.ts';
import type DrawableSlider from '../../BeatmapSet/Beatmap/HitObjects/DrawableSlider.ts';
import type ExperimentalConfig from '../../Config/ExperimentalConfig.ts';
import type SkinningConfig from '../../Config/SkinningConfig.ts';
import { inject } from '../../Context.ts';
import { darken, lighten } from '../../utils.ts';
import { Color } from 'pixi.js';
import type Gameplays from '../../UI/main/viewer/Gameplay/Gameplays.ts';

const blur = new URLSearchParams(globalThis.location.search).get('blur');

export const refreshColor = (drawable: DrawableSlider) => {
	const skin = drawable.skinManager?.getCurrentSkin();
	if (!skin) return;

	const beatmap = drawable.context.consume<Beatmap>('beatmapObject');
	const tintByDiff =
		(inject<Gameplays>('ui/main/viewer/gameplays')?.gameplays.size ?? 1) - 1 &&
		inject<ExperimentalConfig>('config/experimental')?.overlapGameplays &&
		beatmap?.randomColor;

	const comboIndex =
		drawable.object.comboIndexWithOffsets %
		(beatmap?.data.colors.comboColors.length &&
		!inject<SkinningConfig>('config/skinning')?.disableBeatmapSkin
			? beatmap?.data.colors.comboColors.length
			: skin.colorsLength);
	const colors = beatmap?.data.colors.comboColors;
	const comboColor =
		colors?.length &&
		!inject<SkinningConfig>('config/skinning')?.disableBeatmapSkin
			? `${colors[comboIndex].red},${colors[comboIndex].green},${colors[comboIndex].blue}`
			: (skin.config.Colours[`Combo${comboIndex + 1}` as keyof typeof skin.config.Colours] ?? 
				skin.config.Colours.Combo1);

	const trackColor = beatmap?.data.colors.sliderTrackColor;
	const trackOverride =
		trackColor && !inject<SkinningConfig>('config/skinning')?.disableBeatmapSkin
			? `${trackColor.red},${trackColor.green},${trackColor.blue}`
			: skin.config.Colours.SliderTrackOverride;

	const color = (tintByDiff ? new Color(beatmap.randomColor).toUint8RgbArray().join(',') : (trackOverride ?? comboColor))
	.split(',')
	.map((value) => +value / 255);
	drawable.trackColor = color;
	drawable.color = comboColor;

	const border =
		beatmap?.data.colors.sliderBorderColor &&
		!inject<SkinningConfig>('config/skinning')?.disableBeatmapSkin
			? Object.values(beatmap?.data.colors.sliderBorderColor)
			.map((val) => val / 255)
			.slice(0, 3)
			: null;
	const borderColor =
		border ??
		skin.config.Colours.SliderBorder.split(',').map((value) => +value / 255);
	drawable.borderColor = borderColor;

	drawable.updateBodyUniforms({
		borderColor,
		innerColor: lighten(
			blur ? [0.5, 0.5, 0.5] : [color[0], color[1], color[2]],
			blur ? 0.1 : 0.5
		),
		outerColor: darken(
			blur ? [0.5, 0.5, 0.5] : [color[0], color[1], color[2]],
			0.1
		),
		borderWidth: 0.128,
		bodyAlpha: 0.7
	});
	drawable.updateSelectionUniforms({
		borderColor: [49 / 255, 151 / 255, 255 / 255],
		borderWidth: 0.128
	});
};