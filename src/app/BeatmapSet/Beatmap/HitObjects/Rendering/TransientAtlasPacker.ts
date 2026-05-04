import { Rectangle } from 'pixi.js';

export default class TransientAtlasPacker {
	private x = 0;
	private y = 0;
	private rowHeight = 0;

	constructor(
		private readonly width: number,
		private readonly height: number,
		private readonly gutter: number
	) { }

	reset() {
		this.x = 0;
		this.y = 0;
		this.rowHeight = 0;
	}

	alloc(width: number, height: number): Rectangle | undefined {
		const outerW = Math.ceil(width) + this.gutter * 2;
		const outerH = Math.ceil(height) + this.gutter * 2;

		if (outerW > this.width || outerH > this.height) return undefined;

		if (this.x + outerW > this.width) {
			this.x = 0;
			this.y += this.rowHeight;
			this.rowHeight = 0;
		}

		if (this.y + outerH > this.height) return undefined;

		const rect = new Rectangle(
			this.x + this.gutter,
			this.y + this.gutter,
			outerW - this.gutter * 2,
			outerH - this.gutter * 2
		);

		this.x += outerW;
		this.rowHeight = Math.max(this.rowHeight, outerH);

		return rect;
	}
}
