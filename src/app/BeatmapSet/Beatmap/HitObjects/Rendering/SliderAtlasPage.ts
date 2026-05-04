import {
	Application,
	Container,
	RenderTexture
} from 'pixi.js';
import SliderInstanceBatch from './SliderInstanceBatch.ts';
import TransientAtlasPacker from './TransientAtlasPacker.ts';

export default class SliderAtlasPage {
	readonly texture: RenderTexture;
	readonly renderRoot = new Container();
	readonly packer: TransientAtlasPacker;

	/** Unified batch. Body and selection segments both go here. */
	readonly batch: SliderInstanceBatch;

	private used = false;

	constructor(
		readonly width: number,
		readonly height: number,
		readonly gutter: number,
		readonly label: string
	) {
		this.packer = new TransientAtlasPacker(width, height, gutter);
		this.texture = RenderTexture.create({
			width,
			height,
			resolution: 1
		});
		this.texture.label = label;

		this.batch = new SliderInstanceBatch(width, height);
		this.renderRoot.addChild(this.batch.mesh);
	}

	beginFrame() {
		this.used = false;
		this.packer.reset();
		this.batch.beginFrame();
	}

	markUsed() {
		this.used = true;
	}

	get isUsed() {
		return this.used;
	}

	upload() {
		this.batch.upload();
	}

	releaseStaging() {
		this.batch.releaseStaging();
	}

	render(app: Application) {
		if (!this.used) return;

		app.renderer.render({
			container: this.renderRoot,
			target: this.texture,
			clear: true
		});
	}

	destroy() {
		this.batch.destroy();
		this.renderRoot.destroy({ children: false });
		this.texture.destroy(true);
	}
}
