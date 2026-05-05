import { Tween } from '@tweenjs/tween.js';
import { Container, Graphics } from 'pixi.js';
import Gameplay from '.';
import { tweenGroup } from '../../../animation/AnimationController.ts';
import Easings from '../../../Easings.ts';

export default class Spinner {
	graphics: Graphics;
	private _lastTime = 0;
	private container: Container;
	private objectsContainer: Container;

	constructor(parent: Gameplay) {
		this.container = parent.container;
		this.objectsContainer = parent.objectsContainer;

		this.graphics = new Graphics();
		this.graphics.arc(0, 0, 30, 0, (5 * Math.PI) / 6).stroke({
			color: 'white',
			width: 10,
			cap: 'round'
		});
	}

	private _spin = false;

	get spin() {
		return this._spin;
	}

	set spin(val: boolean) {
		if (val) {
			this._spin = val;
			this.graphics.alpha = 1;
			this.container.addChild(this.graphics);
			this.objectsContainer.alpha = 0;
			this.graphics.onRender = renderer => this.spinFn(renderer.tick * 5);
		} else {
			const tween = new Tween({ value: 100 })
				.easing(Easings.Out)
				.to({ value: 0 }, 500)
				.onUpdate(({ value }) => {
					this.graphics.alpha = value / 100;
					this.objectsContainer.alpha = 1 - value / 100;
				})
				.onComplete(() => {
					this.container.removeChild(this.graphics);
					tweenGroup.remove(tween);
					this.objectsContainer.alpha = 1;
					this._spin = val;
				})
				.onStop(() => {
					this.container.removeChild(this.graphics);
					tweenGroup.remove(tween);
					this.objectsContainer.alpha = 1;
					this._spin = val;
				})
				.start();

			tweenGroup.add(tween);

			this.graphics.onRender = null;
		}
	}

	spinFn(t: number) {
		this.graphics.angle += (t - this._lastTime);
		this._lastTime = t;
	}
}
