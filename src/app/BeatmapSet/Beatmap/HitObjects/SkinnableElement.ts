import { inject, ScopedClass } from '../../../Context.ts';
import SkinManager from '../../../Skinning/SkinManager.ts';
import { GameplaysEventCallback } from '../../../UI/main/viewer/Gameplay/Gameplays.ts';

export default abstract class SkinnableElement extends ScopedClass {
	skinManager?: SkinManager;
	gameplaysEventCallback?: GameplaysEventCallback;

	constructor() {
		super();
		this.skinManager = inject<SkinManager>('skinManager');
	}
}
