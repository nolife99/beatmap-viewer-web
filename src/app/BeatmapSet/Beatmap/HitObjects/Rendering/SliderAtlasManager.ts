import type { Renderer } from 'pixi.js';
import SliderAtlasPage from './SliderAtlasPage.ts';
import SliderCoverageScratch from './SliderCoverageScratch.ts';

type RetiredPage = { value: SliderAtlasPage; retireFrame: number };

const PAGE_RETIRE_FRAMES = 2;
const MAX_REUSED_PAGE_AREA_RATIO = 4;

export default class SliderAtlasManager {
	readonly pages: SliderAtlasPage[] = [];
	private readonly coverageScratch = new SliderCoverageScratch();
	private readonly retiredPages: RetiredPage[] = [];

	constructor(
		private readonly bucketSize: number,
		private readonly minSize: number
	) {}

	beginFrame() { for (const page of this.pages) page.beginFrame(); }
	upload() { for (const page of this.pages) page.upload(); }
	render(renderer: Renderer) { for (const page of this.pages) page.render(renderer, this.coverageScratch); }
	releaseStaging() { for (const page of this.pages) page.releaseStaging(); }

	getOrCreate(index: number, width: number, height: number, frameId: number): SliderAtlasPage {
		width = this.bucket(width);
		height = this.bucket(height);

		let page = this.pages[index];
		if (page && page.width >= width && page.height >= height && page.width * page.height <= width * height * MAX_REUSED_PAGE_AREA_RATIO) {
			return page;
		}

		if (page) this.retire(page, frameId);
		page = new SliderAtlasPage(width, height, `slider-atlas-${index}-${width}x${height}`);
		this.pages[index] = page;
		return page;
	}

	trim(count: number, frameId: number) {
		for (let i = count; i < this.pages.length; i++) this.retire(this.pages[i], frameId);
		this.pages.length = count;
	}

	collectRetired(frameId: number) {
		let write = 0;
		for (let i = 0; i < this.retiredPages.length; i++) {
			const item = this.retiredPages[i];
			if (frameId - item.retireFrame >= PAGE_RETIRE_FRAMES) item.value.destroy();
			else this.retiredPages[write++] = item;
		}
		this.retiredPages.length = write;
	}

	destroy() {
		for (const page of this.pages) page.destroy();
		for (const retired of this.retiredPages) retired.value.destroy();
		this.pages.length = this.retiredPages.length = 0;
		this.coverageScratch.destroy();
	}

	private retire(value: SliderAtlasPage, retireFrame: number) {
		this.retiredPages.push({ value, retireFrame });
	}

	private bucket(value: number) {
		return Math.max(this.minSize, Math.ceil(value / this.bucketSize) * this.bucketSize);
	}
}
