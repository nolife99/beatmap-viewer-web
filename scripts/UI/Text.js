import * as PIXI from "pixi.js";

export class Text {
    constructor({ text, renderMode, style }) {
        this._text = text;

        this._sprite = new PIXI.Text(
            this.text,
            // renderMode: renderMode ?? "canvas",
            new PIXI.TextStyle(style)
        );

        this._metrics = PIXI.TextMetrics.measureText(text, new PIXI.TextStyle(style));
        this._color = style.fill;

        this._x = 0;
        this._y = 0;
    }

    get text() {
        return this._text;
    }

    set text(val) {
        if (this._text === val) return;

        this._text = val;
        this._sprite.text = val;
        this._metrics = PIXI.TextMetrics.measureText(val, this._sprite.style);
        this._resize();
    }

    get color() {
        return this._color;
    }

    set color(val) {
        if (val === this._color) return;
        this._color = val;
        this.style.fill = val;
    }

    get sprite() {
        return this._sprite;
    }

    get style() {
        return this._sprite.style;
    }

    get width() {
        return this._metrics.width;
    }

    get height() {
        return this._metrics.height;
    }

    get x() {
        return this._x;
    }

    set x(val) {
        if (this._x === val) return;
        this._x = val;
        this.update();
    }

    get y() {
        return this._y;
    }

    set y(val) {
        if (this._y === val) return;
        this._y = val;
        this.update();
    }

    _resize() {
        this._metrics = PIXI.TextMetrics.measureText(this.text, this.style);
    }

    update() {
        this._resize();
        this.sprite.x = this.x;
        this.sprite.y = this.y;
    }
}
