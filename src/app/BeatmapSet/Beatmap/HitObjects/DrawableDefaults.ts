import type {Circle, StandardHitObject} from "osu-standard-stable";
import {Container, Sprite} from "pixi.js";
import {update} from "@/Skinning/Legacy/LegacyDefaults";
import type Skin from "@/Skinning/Skin";
import SkinnableElement from "./SkinnableElement";
import type {Context} from "@/Context";

export default class DrawableDefaults extends SkinnableElement {
	container: Container;
	digits: string[] = [];

	constructor(object: StandardHitObject) {
		super();
		this.container = new Container();
		this.object = object;

		this.container.scale.set(0.8);
		this.container.interactive = false;
		this.container.interactiveChildren = false;

		const number = object.currentComboIndex + 1;
		const digits = number.toString().split("");

		this.container.addChild(...digits.map<Sprite>(() => new Sprite({ anchor: { x: 0, y: 0.5 } })));
		this.refreshSprites();

		this.skinEventCallback = this.skinManager?.addSkinChangeListener(() => this.refreshSprites());
	}

	private _object!: Circle;
	get object() {
		return this._object;
	}

	set object(val: Circle) {
		this._object = val;

		const number = val.currentComboIndex + 1;
		this.digits = number.toString().split("");
	}

	refreshSprites(skin?: Skin) {
		const s = skin ?? this.skinManager?.getCurrentSkin();
		if (!s) return;
		
		let width = s.config.Fonts.HitCircleOverlap;

		const children = this.container.children;
		for (let i = 0; i < children.length; i++) {
			const text = children[i];
			const digit = this.digits[i];

			width -= s.config.Fonts.HitCircleOverlap;
			const texture = s.getTexture(
				`default-${digit}`,
				this.context.consume<Skin>("beatmapSkin"),
			);
			text.x = width;

			if (texture) {
				(text as Sprite).texture = texture;
				width += texture.width;
			}
		}
		this.container.x = (-width / 2) * 0.8;
		// this.container.x = 0;
		this.container.y = 0;
	}
	
	hook(context: Context) {
		super.hook(context);
		this.refreshSprites();
		return this;
	}

	update(time: number) {
		update(this, time);
	}

	destroy() {
		if (this.skinEventCallback)
			this.skinManager?.removeSkinChangeListener(this.skinEventCallback);

		this.container.destroy({ children: true });
	}
}
