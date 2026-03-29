import type { Vector2 } from "osu-classes";
import type { Slider, StandardHitObject } from "osu-standard-stable";
import { Container, Sprite } from "pixi.js";
import { update } from "@/Skinning/Shared/FollowPoints";
import type Skin from "@/Skinning/Skin";
import { BLANK_TEXTURE } from "@/Skinning/Skin";
import { Clamp } from "@/utils";
import AnimatedSkinnableElement from "./AnimatedSkinnableElement";
import type { Context } from "@/Context";

export default class DrawableFollowPoints extends AnimatedSkinnableElement {
	container: Container = new Container();

	startTime!: number;
	endTime!: number;

	startPosition!: Vector2;
	endPosition!: Vector2;

	distance!: number;

	get duration() {
		return this.endTime - this.startTime;
	}

	constructor(
		public startObject: StandardHitObject,
		public endObject: StandardHitObject,
	) {
		super();

		this.updateObjects(startObject, endObject);

		this.skinEventCallback = this.skinManager?.addSkinChangeListener((skin) => {
			const followpoint = skin.getAnimatedTexture(
				"followpoint",
				this.context.consume<Skin>("beatmapSkin"),
			);

			this.container.blendMode = skin.config.General.Argon ? "add" : "normal";
			this.texturesList = followpoint;
		});
	}

	updateObjects(startObject: StandardHitObject, endObject: StandardHitObject) {
		this.startObject = startObject;
		this.endObject = endObject;

		this.startTime =
			(this.startObject as unknown as Slider).endTime ??
			this.startObject.startTime;
		this.endTime = this.endObject.startTime;

		this.startPosition = this.startObject.endPosition.add(
			this.startObject.stackedOffset,
		);
		this.endPosition = this.endObject.startPosition.add(
			this.endObject.stackedOffset,
		);

		this.distance = this.endPosition.distance(this.startPosition);

		const vector = this.endPosition.subtract(this.startPosition).normalize();
		const angle = Math.atan2(vector.y, vector.x);

		this.container.x = this.startPosition.x;
		this.container.y = this.startPosition.y;
		this.container.rotation = angle;

		for (const sprite of this.container.removeChildren()) {
			sprite.destroy();
		}

		const numberOfSprites =
			this.distance < 80 ? 0 : Math.floor((this.distance - 48) / (512 / 16));

		for (let i = 0; i < numberOfSprites; i++) {
			this.container.addChild(new Sprite({ anchor: 0.5, x: (1.5 + i) * (512 / 16) }));
		}

		this.texturesList = this.skinManager
			?.getCurrentSkin()
			.getAnimatedTexture(
				"followpoint",
				this.context.consume<Skin>("beatmapSkin"),
			) ?? [BLANK_TEXTURE];
	}
	
	hook(context: Context) {
        super.hook(context);
        this.updateObjects(this.startObject, this.endObject);
        return this;
	}

	update(time: number) {
		update(this, time);

		for (const [idx, sprite] of Object.entries(this.container.children)) {
			const d = 32 * 1.5 + 32 * +idx;
			const f = d / this.distance;

			const fadeOutTime = this.startTime + f * this.duration;
			const fadeInTime = fadeOutTime - this.startObject.timePreempt;
			const frameLength = (fadeOutTime - fadeInTime) / this.texturesList.length;

			const frameIndex = Clamp(
				Math.floor((time - fadeInTime) / frameLength),
				0,
				this.texturesList.length - 1,
			);

			(sprite as Sprite).texture = this.texturesList[frameIndex];
		}
	}

	destroy() {
		this.container.destroy({ children: true });

		if (this.skinEventCallback)
			this.skinManager?.removeSkinChangeListener(this.skinEventCallback);
	}
}
