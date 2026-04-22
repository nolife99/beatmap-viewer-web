import { LayoutContainer } from '@pixi/layout/components';
import { BitmapText, Container, Texture } from 'pixi.js';
import type ColorConfig from '../../../../../Config/ColorConfig.ts';
import type FullscreenConfig from '../../../../../Config/FullscreenConfig.ts';
import type TimelineConfig from '../../../../../Config/TimelineConfig.ts';
import { inject } from '../../../../../Context.ts';
import type ResponsiveHandler from '../../../../../ResponsiveHandler.ts';
import { defaultStyle } from '../../../../sidepanel/Metadata.ts';
import Button from './Button.ts';

export default class Beatsnap {
  container: LayoutContainer;

  constructor() {
    this.container = new LayoutContainer({
      layout: {
        width: 160,
        height: 80,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        paddingInline: 20,
        paddingBlock: 5,
        gap: 5,
        backgroundColor: inject<ColorConfig>("config/color")?.color.mantle,
      },
    });

    const text = new BitmapText({
      text: "Beat Snap Divisor",
      style: {
        ...defaultStyle,
        fontSize: 14,
        fontWeight: "500",
        align: "center",
        fill: inject<ColorConfig>("config/color")?.color.text,
      },
      layout: {
        objectFit: "none",
        width: "100%",
      },
    });

    const divisorText = new BitmapText({
      text: `1/${inject<TimelineConfig>("config/timeline")?.divisor ?? 4}`,
      style: {
        ...defaultStyle,
        wordWrap: false,
        fontSize: 14,
        fill: inject<ColorConfig>("config/color")?.color.text,
      },
      layout: {
        objectFit: "none",
      },
    });

    const divisorDown = new Button("left.png", () => {
      const timeline = inject<TimelineConfig>("config/timeline");
      if (!timeline) return;

      timeline.divisor = Math.max(
        1,
        timeline.divisor === 16
          ? 12
          : timeline.divisor === 12
          ? 9
          : timeline.divisor - 1,
      );
    });

    const divisorUp = new Button("right.png", () => {
      const timeline = inject<TimelineConfig>("config/timeline");
      if (!timeline) return;

      timeline.divisor = Math.min(
        16,
        timeline.divisor === 9
          ? 12
          : timeline.divisor === 12
          ? 16
          : timeline.divisor + 1,
      );
    });

    const divisorContainer = new Container({
      layout: {
        width: "100%",
        justifyContent: "space-between",
        alignItems: "center",
      },
    });

    this.container.addChild(text, divisorContainer);
    divisorContainer.addChild(
      divisorDown.container,
      divisorText,
      divisorUp.container,
    );

    inject<FullscreenConfig>("config/fullscreen")?.onChange(
      "fullscreen",
      (isFullscreen) => {
        if (isFullscreen) {
          this.container.renderable = false;
        }

        if (!isFullscreen) {
          this.container.renderable = true;
        }
      },
    );

    inject<ColorConfig>("config/color")?.onChange(
      "color",
      ({ mantle, text: color }) => {
        this.container.layout = { backgroundColor: mantle };
        text.style.fill = color;
        divisorText.style.fill = color;
      },
    );

    inject<ResponsiveHandler>("responsiveHandler")?.on(
      "layout",
      (direction) => {
        if (direction === "landscape") {
          text.visible = true;
          this.container.layout = { width: 160 };
          divisorContainer.layout = { flexDirection: "row", height: undefined };

          divisorDown.sprite.texture = Texture.from("left.png");

          divisorUp.sprite.texture = Texture.from("right.png");

          return;
        }

        if (direction === "portrait") {
          text.visible = false;
          this.container.layout = { width: 40 };
          divisorContainer.layout = { flexDirection: "column", height: "100%" };

          divisorDown.sprite.texture = Texture.from("up.png");

          divisorUp.sprite.texture = Texture.from("down.png");

          return;
        }
      },
    );

    inject<TimelineConfig>("config/timeline")?.onChange("divisor", (val) => {
      divisorText.text = `1/${val}`;
    });
  }
}
