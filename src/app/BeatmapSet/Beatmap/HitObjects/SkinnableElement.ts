import { inject, ScopedClass } from '../../../Context.ts';
import SkinManager, { SkinEventCallback } from '../../../Skinning/SkinManager.ts';
import { GameplaysEventCallback } from '../../../UI/main/viewer/Gameplay/Gameplays.ts';

export default abstract class SkinnableElement extends ScopedClass {
	skinManager?: SkinManager;
	skinEventCallback?: SkinEventCallback;
	gameplaysEventCallback?: GameplaysEventCallback;

	constructor() {
		super();
		this.skinManager = inject<SkinManager>('skinManager');
	}
}
