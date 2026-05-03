import 'pixi.js/text-bitmap';
import { Assets } from 'pixi.js';
import { BITMAP_FONT_ASSETS } from './generatedBitmapFonts.ts';

let bitmapFontLoadPromise: Promise<void> | undefined;

export function loadBitmapFonts(): Promise<void> {
	bitmapFontLoadPromise ??= Promise.all(
		BITMAP_FONT_ASSETS.map((font) => Assets.load(font.url))
	).then(() => undefined);

	return bitmapFontLoadPromise;
}