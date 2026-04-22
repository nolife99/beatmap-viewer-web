import type DrawableApproachCircle from '../../BeatmapSet/Beatmap/HitObjects/DrawableApproachCircle.ts';
import { sharedUpdate } from '../Shared/ApproachCircle.ts';

export const update = (drawable: DrawableApproachCircle, time: number) => {
  const scale = sharedUpdate(drawable, time);
  drawable.container.scale.set((4 - scale) * drawable.object.scale * 1.02);
};
