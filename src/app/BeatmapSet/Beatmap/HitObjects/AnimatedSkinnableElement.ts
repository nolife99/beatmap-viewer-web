import type { Texture } from 'pixi.js';
import SkinnableElement from './SkinnableElement.ts';

export default class AnimatedSkinnableElement extends SkinnableElement {
	texturesList: Texture[] = [];
}