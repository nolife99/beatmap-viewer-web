import type DrawableSlider from '../../BeatmapSet/Beatmap/HitObjects/DrawableSlider.ts';
import type DrawableSliderFollowCircle from '../../BeatmapSet/Beatmap/HitObjects/DrawableSliderFollowCircle.ts';
import Easings from '../../UI/Easings.ts';
import { Clamp } from '../../utils.ts';

export const update = (drawable: DrawableSliderFollowCircle, time: number) => {
  const slider = drawable.context.consume<DrawableSlider>("drawable");
  const currentTrackingFrame = slider?.evaluation?.trackingStates.findLast(
    (frame) => frame[0].startTime <= time,
  );

  const startTime = currentTrackingFrame?.[0].startTime ??
    drawable.object.startTime;
  const endTime = currentTrackingFrame?.[1].startTime ??
    drawable.object.endTime;

  const duration = 300;

  if (time < startTime || time > endTime + duration) {
    drawable.container.visible = false;
    return;
  }

  drawable.container.visible = true;

  if (time >= startTime && time <= endTime) {
    const opacity = Math.min(1, Math.max(0, (time - startTime) / duration));
    const scale = Math.min(1, Math.max(0, (time - startTime) / duration));

    drawable.container.scale.set(
      (1 + 1.4 * Easings.OutQuint(scale)) * drawable.object.scale,
    );
    drawable.container.alpha = Easings.OutQuint(opacity);

    return;
  }

  const maxScale = 1 +
    1.4 * Clamp(Easings.OutQuint((endTime - startTime) / duration));

  if (time > endTime) {
    const opacity = Math.min(1, Math.max(0, (time - endTime) / (duration / 2)));
    const scale = Math.min(1, Math.max(0, (time - endTime) / duration));

    drawable.container.scale.set(
      (maxScale - (maxScale - 1) * Easings.OutQuint(scale)) *
        drawable.object.scale,
    );
    drawable.container.alpha = 1 - Easings.OutQuint(opacity);

    return;
  }
};
