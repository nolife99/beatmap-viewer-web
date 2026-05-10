import { Mesh, type Renderer, RenderTarget, RenderTexture } from 'pixi.js';
import type SliderCoverageScratch from './SliderCoverageScratch.ts';
import SliderCoverageBatch from './SliderCoverageBatch.ts';
import SliderResolveBatch from './SliderResolveBatch.ts';

export default class SliderAtlasPage {
	readonly texture: RenderTexture;
	readonly batch: SliderCoverageBatch;
	readonly resolveBatch: SliderResolveBatch;

	private readonly target: RenderTarget;
	private used = false;

	constructor(
		readonly width: number,
		readonly height: number,
		readonly label: string
	) {
		this.texture = createAtlasTexture(width, height, label);
		this.target = createDepthlessTarget(this.texture, width, height);
		this.batch = new SliderCoverageBatch(width, height);
		this.resolveBatch = new SliderResolveBatch(width, height);
	}

	beginFrame() {
		this.used = false;
		this.batch.beginFrame();
		this.resolveBatch.beginFrame();
	}

	markUsed() {
		this.used = true;
	}

	upload() {
		this.batch.upload();
		this.resolveBatch.upload();
	}

	releaseStaging() {
		this.batch.releaseStaging();
		this.resolveBatch.releaseStaging();
	}

	render(renderer: Renderer, coverage: SliderCoverageScratch) {
		if (!this.used) return;

		const renderTarget = renderer.renderTarget;
		coverage.resize(this.width, this.height);

		renderTarget.push(coverage.target, true);
		this.batch.applyRenderState(renderer);
		try {
			renderer.renderPipes.mesh.execute(this.batch.mesh as Mesh);
		} finally {
			renderTarget.pop();
		}

		renderTarget.push(this.target, true);
		this.resolveBatch.applyRenderState(renderer, coverage.texture);
		try {
			renderer.renderPipes.mesh.execute(this.resolveBatch.mesh as Mesh);
		} finally {
			renderTarget.pop();
		}
	}

	destroy() {
		this.resolveBatch.destroy();
		this.batch.destroy();
		this.target.destroy();
		this.texture.destroy(true);
	}
}

function createAtlasTexture(width: number, height: number, label: string): RenderTexture {
	const texture = RenderTexture.create({
		width,
		height,
		resolution: 1,
		antialias: false,
		autoGenerateMipmaps: false,
		mipLevelCount: 1
	});

	texture.label = label;
	return texture;
}

function createDepthlessTarget(texture: RenderTexture, width: number, height: number): RenderTarget {
	return new RenderTarget({
		width,
		height,
		resolution: 1,
		colorTextures: [texture.source],
		depth: false,
		stencil: false,
		depthStencilTexture: false
	});
}
