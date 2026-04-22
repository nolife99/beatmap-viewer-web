import DrawableHitCircle from '../../BeatmapSet/Beatmap/HitObjects/DrawableHitCircle.ts';
import Beatmap from '../../BeatmapSet/Beatmap/index.ts';
import ExperimentalConfig from '../../Config/ExperimentalConfig.ts';
import SkinningConfig from '../../Config/SkinningConfig.ts';
import { inject } from '../../Context.ts';
import Gameplays from '../../UI/main/viewer/Gameplay/Gameplays.ts';
import Skin from '../Skin.ts';

export const sharedRefreshSprite = (drawable: DrawableHitCircle) => {
	const skin = drawable.skinManager?.getCurrentSkin();
	if (!skin) return;

	const hitCircle = skin.getTexture(
		'hitcircle',
		!skin.config.General.Argon
			? drawable.context.consume<Skin>('beatmapSkin')
			: undefined
	);
	const hitCircleOverlay = skin.getTexture(
		'hitcircleoverlay',
		!skin.config.General.Argon
			? drawable.context.consume<Skin>('beatmapSkin')
			: undefined
	);
	const hitCircleSelect = skin.getTexture(
		'hitcircleselect',
		!skin.config.General.Argon
			? drawable.context.consume<Skin>('beatmapSkin')
			: undefined
	);

	if (hitCircle) drawable.hitCircleSprite.texture = hitCircle;
	if (hitCircleOverlay) drawable.hitCircleOverlay.texture = hitCircleOverlay;
	if (hitCircleSelect) drawable.select.texture = hitCircleSelect;

	drawable.hitCircleOverlay.alpha = 1;
	drawable.hitCircleSprite.alpha = 1;

	sharedRefreshColor(drawable);

	drawable.timelineObject?.refreshSprite();
};

export const sharedRefreshColor = (drawable: DrawableHitCircle) => {
	const skin = drawable.skinManager?.getCurrentSkin();
	if (!skin) return;

	const beatmap = drawable.context.consume<Beatmap>('beatmapObject');
	const tintByDiff =
		(inject<Gameplays>('ui/main/viewer/gameplays')?.gameplays.size ?? 1) - 1 &&
		inject<ExperimentalConfig>('config/experimental')?.overlapGameplays &&
		beatmap?.randomColor;

	if (tintByDiff) {
		drawable.color = beatmap.randomColor;
		drawable.hitCircleSprite.tint = beatmap.randomColor;
		drawable.flashPiece.tint = beatmap.randomColor;
		return;
	}

	if (
		beatmap?.data?.colors.comboColors.length &&
		!inject<SkinningConfig>('config/skinning')?.disableBeatmapSkin
	) {
		const colors = beatmap.data.colors.comboColors;
		const comboIndex = drawable.object.comboIndexWithOffsets % colors.length;

		drawable.hitCircleSprite.tint = `rgb(${colors[comboIndex].red},${colors[comboIndex].green},${colors[comboIndex].blue})`;
		drawable.flashPiece.tint = `rgb(${colors[comboIndex].red},${colors[comboIndex].green},${colors[comboIndex].blue})`;

		drawable.color = `rgb(${colors[comboIndex].red},${colors[comboIndex].green},${colors[comboIndex].blue})`;

		return;
	}

	const comboIndex = drawable.object.comboIndexWithOffsets % skin.colorsLength;
	const key = `Combo${comboIndex + 1}` as keyof typeof skin.config.Colours;
	const color = skin.config.Colours[key] ?? skin.config.Colours.Combo1;

	drawable.color = `rgb(${color})`;
	drawable.hitCircleSprite.tint = `rgb(${color})`;
	drawable.flashPiece.tint = `rgb(${color})`;
};
