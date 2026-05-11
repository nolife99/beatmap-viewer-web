import { RenderTarget, RenderTexture } from 'pixi.js';

export default class SliderCoverageScratch {
	texture!: RenderTexture;
	target!: RenderTarget;
	width = 0;
	height = 0;

	resize(width: number, height: number) {
		if (this.width === width && this.height === height) return;

		this.destroy();
		this.width = width;
		this.height = height;
		this.texture = createTexture(width, height);
		this.target = new RenderTarget({
			width,
			height,
			resolution: 1,
			colorTextures: [this.texture.source],
			depth: false,
			stencil: false,
			depthStencilTexture: false
		});
	}

	destroy() {
		this.target?.destroy();
		this.texture?.destroy(true);
		this.width = 0;
		this.height = 0;
	}
}

function createTexture(width: number, height: number): RenderTexture {
	const texture = RenderTexture.create({
		width,
		height,
		resolution: 1,
		antialias: false,
		autoGenerateMipmaps: false,
		mipLevelCount: 1,
		scaleMode: 'linear',
		alphaMode: 'no-premultiply-alpha'
	});

	texture.label = `slider-coverage-scratch-${width}x${height}`;
	return texture;
}
