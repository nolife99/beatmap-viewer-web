import { Mesh, type Renderer, RenderTexture } from 'pixi.js';
import SliderInstanceBatch from './SliderInstanceBatch.ts';

export default class SliderAtlasPage {
	readonly texture: RenderTexture;
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
	}

	beginFrame() {
		this.used = false;
		this.batch.beginFrame();
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

	render(renderer: Renderer) {
		if (!this.used) return;

		const renderTarget = renderer.renderTarget;
		renderTarget.push(this.texture, true);

		this.batch.applyRenderState(renderer);

		try {
			renderer.renderPipes.mesh.execute(this.batch.mesh as Mesh);
		} finally {
			renderTarget.pop();
		}
	}

	destroy() {
		this.batch.destroy();
		this.texture.destroy(true);
	}
}
