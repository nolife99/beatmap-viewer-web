import {
	Application,
	Container, Renderer,
	RenderTexture
} from 'pixi.js';
import SliderInstanceBatch from './SliderInstanceBatch.ts';

export default class SliderAtlasPage {
	readonly texture: RenderTexture;
	readonly renderRoot = new Container();
	readonly batch: SliderInstanceBatch;

	private used = false;

	constructor(
		readonly width: number,
		readonly height: number,
		readonly label: string
	) {
		this.texture = RenderTexture.create({
			width,
			height,
			resolution: 1
		});
		this.texture.label = label;

		this.batch = new SliderInstanceBatch(width, height);
		this.renderRoot.addChild(this.batch.mesh);
	}

	beginFrame(renderer: Renderer) {
		this.used = false;
		this.batch.beginFrame(renderer);
	}

	markUsed() {
		this.used = true;
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
