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
	readonly bodyBatch: SliderInstanceBatch;
	readonly selectionBatch: SliderInstanceBatch;

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

		this.bodyBatch = new SliderInstanceBatch(width, height);
		this.selectionBatch = new SliderInstanceBatch(width, height);

		this.renderRoot.addChild(this.bodyBatch.mesh);
		this.renderRoot.addChild(this.selectionBatch.mesh);
	}

	beginFrame() {
		this.used = false;
		this.packer.reset();
		this.bodyBatch.beginFrame();
		this.selectionBatch.beginFrame();
	}

	markUsed() {
		this.used = true;
	}

	get isUsed() {
		return this.used;
	}

	upload() {
		this.bodyBatch.upload();
		this.selectionBatch.upload();
	}

	render(app: Application) {
		if (!this.used) return;

		app.renderer.render({
			container: this.renderRoot,
			target: this.texture,
			clear: true
		});
	}

	releaseStaging() {
		this.bodyBatch.releaseStaging();
		this.selectionBatch.releaseStaging();
	}

	destroy() {
		this.bodyBatch.destroy();
		this.selectionBatch.destroy();
		this.renderRoot.destroy({ children: false });
		this.texture.destroy(true);
	}
}
