import { Buffer, BufferUsage, GlProgram, GpuProgram } from 'pixi.js';
import fragment from './Shaders/sliderAtlasBatch.frag?raw';
import vertex from './Shaders/sliderAtlasBatch.vert?raw';
import gpuSrc from './Shaders/sliderAtlasBatch.wgsl?raw';

export const ATLAS_GL = new GlProgram({ vertex, fragment });

export const ATLAS_GPU = GpuProgram.from({
	vertex: { source: gpuSrc, entryPoint: 'vsMain' },
	fragment: { source: gpuSrc, entryPoint: 'fsMain' }
});

export const quadPositions = new Buffer({
	data: [
		0, 1,
		0, -1,
		1, -1,

		0, 1,
		1, -1,
		1, 1
	],
	usage: BufferUsage.VERTEX
});
