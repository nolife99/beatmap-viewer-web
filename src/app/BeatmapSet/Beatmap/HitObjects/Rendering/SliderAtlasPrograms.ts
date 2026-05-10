import { Buffer, BufferUsage, GlProgram, GpuProgram } from 'pixi.js';
import coverageFragment from './Shaders/sliderCoverageBatch.frag?raw';
import coverageVertex from './Shaders/sliderCoverageBatch.vert?raw';
import coverageGpuSrc from './Shaders/sliderCoverageBatch.wgsl?raw';
import resolveFragment from './Shaders/sliderResolveBatch.frag?raw';
import resolveVertex from './Shaders/sliderResolveBatch.vert?raw';
import resolveGpuSrc from './Shaders/sliderResolveBatch.wgsl?raw';

export const ATLAS_COVERAGE_GL = new GlProgram({ vertex: coverageVertex, fragment: coverageFragment });
export const ATLAS_COVERAGE_GPU = GpuProgram.from({
	vertex: { source: coverageGpuSrc, entryPoint: 'vsMain' },
	fragment: { source: coverageGpuSrc, entryPoint: 'fsMain' }
});

export const ATLAS_RESOLVE_GL = new GlProgram({ vertex: resolveVertex, fragment: resolveFragment });
export const ATLAS_RESOLVE_GPU = GpuProgram.from({
	vertex: { source: resolveGpuSrc, entryPoint: 'vsMain' },
	fragment: { source: resolveGpuSrc, entryPoint: 'fsMain' }
});

export const segmentQuadPositions = new Buffer({
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

export const resolveQuadPositions = new Buffer({
	data: [
		0, 0,
		0, 1,
		1, 1,

		0, 0,
		1, 1,
		1, 0
	],
	usage: BufferUsage.VERTEX
});
