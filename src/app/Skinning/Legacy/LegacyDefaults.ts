import DrawableDefaults from '../../BeatmapSet/Beatmap/HitObjects/DrawableDefaults.ts';
import DrawableHitObject from '../../BeatmapSet/Beatmap/HitObjects/DrawableHitObject.ts';
import GameplayConfig from '../../Config/GameplayConfig.ts';
import { inject } from '../../Context.ts';

export const update = (drawable: DrawableDefaults, time: number) => {
	const fadeOutDuration = 60;
	const object = drawable.context.consume<DrawableHitObject>('drawable');
	const startTime = object?.evaluation?.hitTime ?? drawable.object.startTime;

	if (!inject<GameplayConfig>('config/gameplay')?.hitAnimation) {
		return surpressAnimation(drawable, time);
	}

	if (time <= startTime) {
		drawable.container.alpha = 1;
		return;
	}

	if (time > startTime && time <= startTime + fadeOutDuration) {
		const opacity = 1 -
			Math.min(1, Math.max(0, (time - startTime) / fadeOutDuration));
		drawable.container.alpha = opacity;

		return;
	}

	drawable.container.alpha = 0;
};

const surpressAnimation = (drawable: DrawableDefaults, _: number) => {
	drawable.container.alpha = 1;
	return;
};
