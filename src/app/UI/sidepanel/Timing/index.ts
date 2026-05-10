import { LayoutContainer } from '@pixi/layout/components';
import { ControlPoint, ControlPointType, DifficultyPoint, type SamplePoint, TimingPoint } from 'osu-classes';
import { BitmapText, Container, type FederatedPointerEvent, Graphics, TextStyleOptions } from 'pixi.js';
import ColorConfig from '../../../Config/ColorConfig.ts';
import { inject } from '../../../Context.ts';
import ResponsiveHandler from '../../../ResponsiveHandler.ts';
import State from '../../../State.ts';
import AnimationController from '../../animation/AnimationController.ts';
import Easings from '../../Easings.ts';
import { millisecondsToMinutesString } from '../../../utils.ts';
import BeatmapSet from '../../../BeatmapSet/index.ts';

// ─── Layout ───────────────────────────────────────────────────────────────────
const ROW_H = 45;  // stride between row tops (px)
const ROW_VISIBLE_H = 40;  // drawn height of each row (5 px gap beneath)
const COL_TS_X = 20;
const COL_C1_X = 100;
const COL_C2_RPAD = 20;  // right-anchor padding

// With lineHeight: ROW_H, Pixi allocates a ROW_H-tall slot per line and centres
// the glyph inside it.  To make that centred glyph land inside the visible 40 px
// row we shift the whole BitmapText up by half the surplus:
//   TEXT_Y = (ROW_VISIBLE_H − ROW_H) / 2 = (40 − 45) / 2 = −2.5 → −2
// The selection BitmapTexts use the same lineHeight so they get the same offset,
// then are positioned at   rowY + TEXT_Y   to match the column slot exactly.
const TEXT_Y = Math.round((ROW_VISIBLE_H - ROW_H) / 2); // −2

// Indicator arrow is 10 px tall; centre it in ROW_VISIBLE_H:
const INDICATOR_Y_IN_ROW = Math.round((ROW_VISIBLE_H - 10) / 2); // 15

// ─── Scroll ───────────────────────────────────────────────────────────────────
const VELOCITY_WINDOW_MS = 80;
const FRICTION_PER_FRAME = 0.90;
const TAP_THRESHOLD_PX = 8;

// ─── Accent colours ───────────────────────────────────────────────────────────
const ACCENT_TIMING = 0xf38ba8;
const ACCENT_DIFFICULTY = 0xa6e3a1;

function pointAccent(p: ControlPoint, textFallback: number): number {
	if (p.pointType === ControlPointType.TimingPoint) return ACCENT_TIMING;
	if (p.pointType === ControlPointType.DifficultyPoint) return ACCENT_DIFFICULTY;
	return textFallback;
}

function trackOf(p: ControlPoint): 0 | 1 | 2 {
	if (p.pointType === ControlPointType.TimingPoint) return 0;
	if (p.pointType === ControlPointType.DifficultyPoint) return 1;
	return 2;
}

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmtC1(p: ControlPoint): string {
	if (p.pointType === ControlPointType.TimingPoint)
		return `${Math.round((p as TimingPoint).bpm)} BPM`;
	if (p.pointType === ControlPointType.DifficultyPoint)
		return `x${(p as DifficultyPoint).sliderVelocity.toFixed(2)}`;
	const s = p as SamplePoint;
	return `${s.sampleSet}: ${s.customIndex === 0 ? 'Default' : `Custom ${s.customIndex}`}`;
}

function fmtC2(p: ControlPoint): string {
	if (p.pointType === ControlPointType.TimingPoint)
		return `Signature ${(p as TimingPoint).timeSignature}/4`;
	if (p.pointType === ControlPointType.DifficultyPoint) return '';
	return `Volume ${(p as SamplePoint).volume}%`;
}

// ─── Shared style factories ────────────────────────────────────────────────────
// Both column texts and selection texts specify lineHeight: ROW_H so that Pixi
// positions the glyph inside the same sized slot in both cases.  The column texts
// use this for multi-line spacing; the selection texts use it for the single line
// they display so the glyph offset within the slot is identical.
function colStyle(bold = false): TextStyleOptions {
	return {
		fontSize: 14,
		fontFamily: 'Rubik',
		fill: 0xffffff,       // tinted below
		lineHeight: ROW_H,
		fontWeight: bold ? '500' : 'normal'
	};
}

// ─── Timing ───────────────────────────────────────────────────────────────────

interface Track {
	ts: BitmapText;
	c1: BitmapText;
	c2: BitmapText;
}

export default class Timing {
	container: LayoutContainer;

	// Scrolling layer — holds the nine column BitmapTexts (3 tracks × 3 columns).
	// alpha = 0.5 fades all unselected rows uniformly.
	private _scroll: Container;

	// Nine column BitmapTexts.  Each track owns one full-list text per column;
	// rows belonging to other tracks are blank lines (no quads, but spacing preserved).
	private _tracks: [Track, Track, Track];

	// Selected-row overlay, full opacity, above _scroll.
	private _selLayer: Container;
	private _selBg: Graphics;
	private _selIndicator: Graphics;
	private _selTs: BitmapText;
	private _selC1: BitmapText;
	private _selC2: BitmapText;

	// Last values used to draw each Graphics object.
	// When they haven't changed we skip the redraw + recache and only reposition.
	private _cachedBgAccent = -1; // accent colour last drawn into _selBg
	private _cachedBgWidth = -1; // container width last drawn into _selBg
	private _cachedIndColor = -1; // bg colour last drawn into _selIndicator

	// State
	private _points: ControlPoint[] = [];
	private _currentIdx = 0;
	private _width = 360;
	private _bg = 0x181825;
	private _textAccent = 0xcdd6f4;
	private _scrollOffset = 0;
	private _animCtrl = new AnimationController();

	// Drag / inertia
	private _isDown = false;
	private _startPosition = 0;
	private _cacheOffset = 0;
	private _currentVelocity = 0;
	private _last = 0;
	private _moveHistory: { y: number; t: number }[] = [];
	private _lastUserScroll = -Infinity;
	private _selfSeeking = false;

	constructor() {
		const cfg = inject<ColorConfig>('config/color');
		this._bg = cfg?.color.mantle ?? 0x181825;
		this._textAccent = cfg?.color.text ?? 0xcdd6f4;

		this.container = new LayoutContainer({
			label: 'timing',
			layout: {
				width: 360,
				flex: 1,
				overflow: 'hidden',
				backgroundColor: this._bg,
				borderRadius: 0
			},
			visible: false
		});

		// ── Scroll layer ──────────────────────────────────────────────────────
		this._scroll = new Container();
		this._scroll.alpha = 0.5;
		this.container.addChild(this._scroll);

		const trackAccents: [number, number, number] = [
			ACCENT_TIMING,
			ACCENT_DIFFICULTY,
			this._textAccent
		];

		this._tracks = trackAccents.map((accent): Track => {
			const make = (x: number, anchorRight = false, bold = false): BitmapText => {
				const t = new BitmapText({ text: '', style: colStyle(bold), layout: false });
				t.tint = accent;
				t.y = TEXT_Y;
				if (anchorRight) {
					t.anchor.set(1, 0);
					t.x = this._width - COL_C2_RPAD;
				} else { t.x = x; }
				this._scroll.addChild(t);
				return t;
			};
			return { ts: make(COL_TS_X), c1: make(COL_C1_X, false, true), c2: make(0, true) };
		}) as [Track, Track, Track];

		// ── Selection overlay ─────────────────────────────────────────────────
		this._selBg = new Graphics();
		this._selIndicator = new Graphics();

		// Selection texts use lineHeight: ROW_H — identical glyph-in-slot offset as columns.
		// Positioned at   rowY + TEXT_Y   so they sit in the same vertical position.
		const makeSel = (x: number, anchorRight = false, bold = false): BitmapText => {
			const t = new BitmapText({ text: '', style: colStyle(bold), layout: false });
			if (anchorRight) {
				t.anchor.set(1, 0);
				t.x = this._width - COL_C2_RPAD;
			} else { t.x = x; }
			return t;
		};

		this._selTs = makeSel(COL_TS_X);
		this._selC1 = makeSel(COL_C1_X, false, true);
		this._selC2 = makeSel(0, true);

		this._selLayer = new Container({ visible: false });
		this._selLayer.addChild(this._selBg, this._selIndicator, this._selTs, this._selC1, this._selC2);
		this.container.addChild(this._selLayer);

		// ── Config reactivity ─────────────────────────────────────────────────
		cfg?.onChange('color', ({ mantle, text }) => {
			this._bg = mantle;
			this._textAccent = text;
			this.container.layout = { backgroundColor: mantle };
			this._tracks[2].ts.tint = text;
			this._tracks[2].c1.tint = text;
			this._tracks[2].c2.tint = text;
			this._applySelection(this._currentIdx);
		});

		// ── Responsive ────────────────────────────────────────────────────────
		inject<ResponsiveHandler>('responsiveHandler')?.on('layout', (dir) => {
			this.container.layout = dir === 'landscape' ? { width: 360 } : { width: '100%' };
		});

		this.container.on('layout', () => {
			const w = this.container.layout?.computedLayout.width ?? 360;
			if (w !== this._width) {
				this._width = w;
				this._repositionRightEdge(w);
			}
			const offset = this._currentIdx * ROW_H
				- (this.container.layout?.computedLayout.height ?? 0) + 40;
			this.scrollTo(Math.max(0, offset));
		});

		inject<State>('state')?.on('sidebar', (s) => {
			this.container.visible = s === 'OPENED';
		});

		// ── Input ─────────────────────────────────────────────────────────────
		this.container.on('wheel', (e) => {
			this._lastUserScroll = performance.now();
			this.scrollTo(this._scrollOffset + e.deltaY * 2);
		});
		this.container.on('pointerdown', (e) => this._onDown(e));
		this.container.on('pointermove', (e) => this._onMove(e));
		this.container.on('pointerup', (e) => this._onUp(e));
		this.container.on('pointerout', () => this._onUp());
	}

	// ── Public API ────────────────────────────────────────────────────────────

	updateTimingPoints(points: ControlPoint[]) {
		this._points = points;
		this._currentIdx = 0;
		this._buildColumns();
		this._applySelection(0);
	}

	scrollToTimingPoint(time: number) {
		const bs = inject<BeatmapSet>('beatmapset');
		if (this._selfSeeking && !bs?.isSeeking) this._selfSeeking = false;
		if (this._selfSeeking) return;

		const idx = this._points.findIndex((p) => p.startTime === time);
		if (idx === -1 || idx === this._currentIdx) return;

		this._currentIdx = idx;
		this._applySelection(idx);

		const h = this.container.layout?.computedLayout.height ?? 0;
		const offset = idx * ROW_H - h + 40;
		if (offset < this._scrollOffset && Math.abs(offset - this._scrollOffset) < h) return;
		if (performance.now() - this._lastUserScroll > 2000) this.scrollTo(Math.max(0, offset));
	}

	scrollTo(offset: number, instant = false) {
		const max = this._maxScroll();
		const clamped = Math.max(-200, Math.min(max + 200, offset));

		if (instant) {
			this._scrollTo(Math.max(0, Math.min(max, clamped)));
			return;
		}

		const tween = this._animCtrl.addAnimation(
			'offset', this._scrollOffset, clamped,
			(v) => {
				this._scrollTo(v);
				if (this._bounceBack()) tween.stop();
			},
			200, Easings.OutCubic,
			() => {
				if (clamped < 0) this.scrollTo(0);
				else if (clamped > max) this.scrollTo(max);
			}
		);
	}

	// ── Input ─────────────────────────────────────────────────────────────────

	private _onDown(e: FederatedPointerEvent) {
		this._isDown = true;
		this._lastUserScroll = performance.now();
		this.container.onRender = null;
		this._cacheOffset = this._scrollOffset;
		this._currentVelocity = 0;
		this._startPosition = e.y;
		this._moveHistory = [{ y: e.y, t: performance.now() }];
	}

	private _onMove(e: FederatedPointerEvent) {
		if (!this._isDown) return;

		const now = performance.now();
		this._moveHistory.push({ y: e.y, t: now });
		const cutoff = now - VELOCITY_WINDOW_MS;
		while (this._moveHistory.length > 1 && this._moveHistory[0].t < cutoff)
			this._moveHistory.shift();

		const delta = e.y - this._startPosition;
		this._scrollTo(Math.max(-200, Math.min(this._maxScroll() + 200, this._cacheOffset - delta)));
	}

	private _onUp(e?: FederatedPointerEvent) {
		if (!this._isDown) return;
		this._isDown = false;

		// Tap → seek
		if (e && Math.abs(this._scrollOffset - this._cacheOffset) < TAP_THRESHOLD_PX) {
			const local = this.container.toLocal(e.global);
			const contentY = local.y + this._scrollOffset;
			const idx = Math.floor(contentY / ROW_H);

			if (idx >= 0 && idx < this._points.length) {
				this._currentIdx = idx;
				this._applySelection(idx);
				this._selfSeeking = true;
				inject<BeatmapSet>('beatmapset')?.smoothSeek(this._points[idx].startTime, 67);
			}

			this._bounceBack(0);
			return;
		}

		// Flick
		if (this._moveHistory.length >= 2) {
			const newest = this._moveHistory[this._moveHistory.length - 1];
			const oldest = this._moveHistory[0];
			const dt = newest.t - oldest.t;
			this._currentVelocity = dt > 5 ? (newest.y - oldest.y) / dt : 0;
		}

		if (Math.abs(this._currentVelocity) < 0.1) {
			this._bounceBack(0);
			return;
		}

		this._last = performance.now();
		this.container.onRender = () => this._stepInertia();
	}

	private _stepInertia() {
		if (this._bounceBack()) {
			this.container.onRender = null;
			return;
		}

		const now = performance.now();
		const delta = now - this._last;
		this._last = now;

		this._scrollTo(this._scrollOffset - delta * this._currentVelocity);
		this._currentVelocity *= Math.pow(FRICTION_PER_FRAME, delta / 16.667);

		if (Math.abs(this._currentVelocity) < 0.02) {
			this.container.onRender = null;
			this._bounceBack(0);
		}
	}

	// ── Internal ─────────────────────────────────────────────────────────────

	private _scrollTo(offset: number) {
		this._scrollOffset = offset;
		this._scroll.y = -offset;
		this._selLayer.y = -offset;
	}

	private _maxScroll(): number {
		return Math.max(
			0,
			this._points.length * ROW_H - 5
			- (this.container.layout?.computedLayout.height ?? 0)
		);
	}

	private _bounceBack(leeway = 200): boolean {
		const max = this._maxScroll();
		if (this._scrollOffset < -leeway) {
			this.scrollTo(0);
			return true;
		}
		if (this._scrollOffset > max + leeway) {
			this.scrollTo(max);
			return true;
		}
		return false;
	}

	// ── Column builder ────────────────────────────────────────────────────────

	private _buildColumns() {
		const ts: [string[], string[], string[]] = [[], [], []];
		const c1: [string[], string[], string[]] = [[], [], []];
		const c2: [string[], string[], string[]] = [[], [], []];

		for (const p of this._points) {
			const own = trackOf(p);
			for (let t = 0; t < 3; t++) {
				ts[t].push(t === own ? millisecondsToMinutesString(p.startTime) : '');
				c1[t].push(t === own ? fmtC1(p) : '');
				c2[t].push(t === own ? fmtC2(p) : '');
			}
		}

		for (let t = 0; t < 3; t++) {
			this._tracks[t].ts.text = ts[t].join('\n');
			this._tracks[t].c1.text = c1[t].join('\n');
			this._tracks[t].c2.text = c2[t].join('\n');
		}
	}

	// ── Selection overlay ─────────────────────────────────────────────────────

	private _applySelection(idx: number) {
		if (!this._points.length || !this._points[idx]) {
			this._selLayer.visible = false;
			return;
		}

		const p = this._points[idx];
		const accent = pointAccent(p, this._textAccent);
		const rowY = idx * ROW_H;

		// ── Background ────────────────────────────────────────────────────────
		// Drawn at local (0, 0); rowY applied via .y so repositioning never
		// triggers a redraw.  Only redraw + recache when colour or width changes.
		if (accent !== this._cachedBgAccent || this._width !== this._cachedBgWidth) {
			this._selBg
				.clear()
				.roundRect(0, 0, this._width, ROW_VISIBLE_H, 10)
				.fill(accent);
			this._selBg.cacheAsTexture(true);
			this._cachedBgAccent = accent;
			this._cachedBgWidth = this._width;
		}
		this._selBg.y = rowY;

		// ── Indicator ─────────────────────────────────────────────────────────
		// Same pattern: shape is static, colour tracks _bg, position via .y.
		if (this._bg !== this._cachedIndColor) {
			this._selIndicator
				.clear()
				.moveTo(0, 0).lineTo(0, 10).lineTo(5, 5).closePath()
				.fill(this._bg);
			this._selIndicator.cacheAsTexture(true);
			this._cachedIndColor = this._bg;
		}
		this._selIndicator.x = 10;
		this._selIndicator.y = rowY + INDICATOR_Y_IN_ROW;

		// ── Text ──────────────────────────────────────────────────────────────
		const textY = rowY + TEXT_Y;
		this._selTs.tint = this._bg;
		this._selC1.tint = this._bg;
		this._selC2.tint = this._bg;
		this._selTs.text = millisecondsToMinutesString(p.startTime);
		this._selC1.text = fmtC1(p);
		this._selC2.text = fmtC2(p);
		this._selTs.y = textY;
		this._selC1.y = textY;
		this._selC2.y = textY;
		this._selC2.x = this._width - COL_C2_RPAD;

		this._selLayer.visible = true;
	}

	// ── Width change ──────────────────────────────────────────────────────────

	private _repositionRightEdge(w: number) {
		for (const track of this._tracks) track.c2.x = w - COL_C2_RPAD;
		this._selC2.x = w - COL_C2_RPAD;
		this._applySelection(this._currentIdx);
	}
}