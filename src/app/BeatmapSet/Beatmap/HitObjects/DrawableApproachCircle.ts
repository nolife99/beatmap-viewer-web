import type { Circle } from 'osu-standard-stable';
import { Sprite } from 'pixi.js';
import type ExperimentalConfig from '../../../Config/ExperimentalConfig.ts';
import type SkinningConfig from '../../../Config/SkinningConfig.ts';
import { inject } from '../../../Context.ts';
import { update as argonUpdate } from '../../../Skinning/Argon/ArgonApproachCircle.ts';
import { update as legacyUpdate } from '../../../Skinning/Legacy/LegacyApproachCircle.ts';
import type Skin from '../../../Skinning/Skin.ts';
import type Gameplays from '../../../UI/main/viewer/Gameplay/Gameplays.ts';
import type Beatmap from '..';
import SkinnableElement from './SkinnableElement.ts';

export default class DrawableApproachCircle extends SkinnableElement {
	container = new Sprite();
	updateFn = legacyUpdate;

	constructor(object: Circle) {
		super();
		this.object = object;

		this.container.visible = false;

		this.container.anchor.set(0.5);
		this.container.interactive = false;
		this.container.interactiveChildren = false;
		this.container.eventMode = 'none';

		this.refreshSprite();
		this.skinEventCallback = this.skinManager?.addSkinChangeListener(() =>
			this.refreshSprite()
		);
		this.gameplaysEventCallback = inject<Gameplays>(
			'ui/main/viewer/gameplays'
		)?.on('change', () => this.refreshColor());
		inject<ExperimentalConfig>('config/experimental')?.onChange('overlapGameplays', () => this.refreshColor());
	}

	private _object!: Circle;

	get object() {
		return this._object;
	}

	set object(val: Circle) {
		this._object = val;

		this.container.x = val.startX + val.stackedOffset.x;
		this.container.y = val.startY + val.stackedOffset.y;
	}

	refreshSprite() {
		const skin = this.skinManager?.getCurrentSkin();
		if (!skin) return;

		if (skin.config.General.Argon) {
			this.updateFn = argonUpdate;
		} else {
			this.updateFn = legacyUpdate;
		}

		const approachCircle = skin.getTexture(
			'approachcircle',
			this.context.consume<Skin>('beatmapSkin')
		);
		if (approachCircle) this.container.texture = approachCircle;

		this.refreshColor();
	}

	refreshColor() {
		const skin = this.skinManager?.getCurrentSkin();
		if (!skin) return;

		const beatmap = this.context.consume<Beatmap>('beatmapObject');
		const tintByDiff =
			(inject<Gameplays>('ui/main/viewer/gameplays')?.gameplays.size ?? 1) - 1 &&
			inject<ExperimentalConfig>('config/experimental')?.overlapGameplays &&
			beatmap?.randomColor;

		if (tintByDiff) {
			this.container.tint = beatmap.randomColor;
			return;
		}

		if (
			beatmap?.data.colors.comboColors.length &&
			!inject<SkinningConfig>('config/skinning')?.disableBeatmapSkin
		) {
			const colors = beatmap.data.colors.comboColors;
			const comboIndex = this.object.comboIndexWithOffsets % colors.length;

			this.container.tint = `rgb(${colors[comboIndex].red},${colors[comboIndex].green},${colors[comboIndex].blue})`;
			return;
		}

		const comboIndex = this.object.comboIndexWithOffsets % skin.colorsLength;
		const key = `Combo${comboIndex + 1}` as keyof typeof skin.config.Colours;
		const color = skin.config.Colours[key] ?? skin.config.Colours.Combo1;
		this.container.tint = `rgb(${color})`;
	}

	update(time: number) {
		this.updateFn(this, time);
	}

	destroy() {
		this.container.destroy();
		if (this.skinEventCallback)
			this.skinManager?.removeSkinChangeListener(this.skinEventCallback);
		if (this.gameplaysEventCallback)
			inject<Gameplays>('ui/main/viewer/gameplays')?.remove(
				'change',
				this.gameplaysEventCallback
			);
	}
}
