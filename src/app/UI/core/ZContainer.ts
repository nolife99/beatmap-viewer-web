import {
	LayoutContainer
} from "@pixi/layout/components";
import AnimationController from "../animation/AnimationController";

export default class ZContainer extends LayoutContainer {
	animationController = new AnimationController();

	triggerAnimation(
		key: string,
		from: number,
		to: number,
		callback: (currentValue: number) => void,
		duration?: number,
		easing?: (t: number) => number,
		onComplete?: () => void,
		onStop?: () => void
	) {
		return this.animationController.addAnimation(
			key,
			from,
			to,
			callback,
			duration,
			easing,
			onComplete,
			onStop
		);
	}
}