import { Beatmap } from "../Beatmap.js";
import { Timeline } from "./Timeline.js";
import { TimelineHitCircle } from "./HitCircle.js";
import { TimelineReverseArrow } from "./ReverseArrow.js";
import { Clamp } from "../Utils.js";
import { Skinning } from "../Skinning.js";
import { Game } from "../Game.js";
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import * as PIXI from "pixi.js";
import gpuShader from "../Shaders/Timeline/SliderBody.wgsl?raw";
import glVertexShader from "../Shaders/Timeline/SliderBody.vert?raw";
import glFragmentShader from "../Shaders/Timeline/SliderBody.frag?raw";

export class TimelineSlider {
    obj;
    hitObject;
    sliderHead;
    sliderTail;
    sliderReverses = [];

    meshHead;
    meshTail;
    meshBody;

    ratio = 1;
    headPosition = 0;

    constructor(hitObject) {
        this.obj = new PIXI.Container();
        // this.obj.interactive = true;
        this.obj.eventMode = "static";

        this.x = 0;
        this.radius = 30.0 * (118 / 128);
        this.hitObject = hitObject;
        this.length = 1;

        this.hitArea = new PIXI.Graphics().drawRect(0, 0, 0, 0);
        this.obj.addChild(this.hitArea);

        const headGeometry = this.createArc(-1, 0);
        const tailGeometry = this.createArc(1, 0);
        const bodyGeometry = this.createLine(1);

        const shader = PIXI.Shader.from(glVertexShader, glFragmentShader, {
            tint: [0.0, 0.0, 0.0, 1.0],
            selected: 0,
        });

        const meshHead = new PIXI.Mesh(headGeometry, shader);
        const meshBody = new PIXI.Mesh(bodyGeometry, shader);
        const meshTail = new PIXI.Mesh(tailGeometry, shader);

        // console.log(shader)

        this.meshHead = meshHead;
        this.meshBody = meshBody;
        this.meshTail = meshTail;

        this.meshHead.hitArea = new PIXI.Rectangle(0, 0, 0, 0);
        this.meshBody.hitArea = new PIXI.Rectangle(0, 0, 0, 0);
        this.meshTail.hitArea = new PIXI.Rectangle(0, 0, 0, 0);

        this.obj.addChild(meshHead);
        this.obj.addChild(meshBody);
        this.obj.addChild(meshTail);

        const sliderHead = new TimelineHitCircle(hitObject);
        const sliderTail = new TimelineHitCircle(hitObject);
        this.sliderHead = sliderHead;
        this.sliderTail = sliderTail;

        this.sliderReverses = this.hitObject.revArrows?.map((arrow) => new TimelineReverseArrow(arrow, this.hitObject)) ?? [];

        this.obj.addChild(sliderTail.obj);
        this.sliderReverses.toReversed().forEach((arrow) => this.obj.addChild(arrow.obj));
        this.obj.addChild(sliderHead.obj);

        const handleClickEvent = (e) => {
            const { x, y } = this.obj.toLocal(e.global);
            if (Game.SELECTED.includes(this.hitObject.time)) return;

            if (x < this.headPosition - (Timeline.HEIGHT - 20) / 2 || x > this.headPosition + this.length * this.ratio + Timeline.HEIGHT / 1.5 / 2)
                return;

            if (!e.ctrlKey) Game.SELECTED = [];
            if (!Game.SELECTED.includes(this.hitObject.time)) Game.SELECTED.push(this.hitObject.time);

            Timeline.hitArea.isObjectSelecting = true;
            // console.log(this.obj.x, this.obj.y, x, y);
        };

        this.obj.on("mousedown", handleClickEvent);
        this.obj.on("touchstart", handleClickEvent);
    }

    addSelfToContainer(container) {
        container.addChild(this.obj);
    }

    removeSelfFromContainer(container) {
        container.removeChild(this.obj);
    }

    draw(timestamp) {
        const time = this.hitObject.time;
        const delta = timestamp - time;

        const selected = Game.SELECTED.includes(time);

        const center = Timeline.WIDTH / 2;

        this.length = ((this.hitObject.endTime - this.hitObject.time) / 500) * Timeline.ZOOM_DISTANCE;

        const colors = Game.SLIDER_APPEARANCE.ignoreSkin ? Skinning.DEFAULT_COLORS : Beatmap.COLORS;
        const idx = Game.SLIDER_APPEARANCE.ignoreSkin ? this.hitObject.colourIdx : this.hitObject.colourHaxedIdx;
        const tint =
            idx === -1
                ? [1.0, 1.0, 1.0, 1.0]
                : [...Object.values(d3.rgb(`#${colors[idx % colors.length].toString(16).padStart(6, "0")}`)).map((val) => val / 255), 1.0];

        let headPosition = Math.max(center - (delta / 500) * Timeline.ZOOM_DISTANCE, 0);
        this.headPosition = headPosition;
        // let headPosition = center - (delta / 500) * Timeline.ZOOM_DISTANCE;
        let endPosition = center - (delta / 500) * Timeline.ZOOM_DISTANCE + this.length;

        if (endPosition < 0) headPosition = endPosition;
        const ratio = Clamp((endPosition - headPosition) / this.length, 0, 1);
        this.ratio = ratio;
        // const ratio = 1;

        this.meshHead.position.set(headPosition, Timeline.HEIGHT / 2);
        this.meshHead.scale.set(Timeline.HEIGHT / (Timeline.SHOW_GREENLINE ? 1.5 : 1) / 60);
        this.meshHead.shader.uniforms.tint = tint;
        this.meshHead.shader.uniforms.selected = selected ? 1 : 0;

        this.meshBody.position.set(headPosition, Timeline.HEIGHT / 2);
        this.meshBody.scale.set(this.length * ratio, Timeline.HEIGHT / (Timeline.SHOW_GREENLINE ? 1.5 : 1) / 60);
        this.meshBody.shader.uniforms.tint = tint;
        this.meshBody.shader.uniforms.selected = selected ? 1 : 0;

        this.meshTail.position.set(endPosition, Timeline.HEIGHT / 2);
        this.meshTail.scale.set(Timeline.HEIGHT / (Timeline.SHOW_GREENLINE ? 1.5 : 1) / 60);
        this.meshTail.shader.uniforms.tint = tint;
        this.meshTail.shader.uniforms.selected = selected ? 1 : 0;

        this.sliderHead.draw(timestamp);
        this.sliderTail.draw(timestamp, true);

        this.sliderHead.obj.x = headPosition;
        this.sliderTail.obj.x = endPosition;

        this.hitArea.clear();
        this.hitArea.beginFill(0xffff00, 0.0001).drawRect(headPosition, 0, this.length * ratio, Timeline.HEIGHT);

        this.sliderReverses.forEach((arrow) => arrow.draw(timestamp));

        if (idx === -1) {
            this.sliderHead.hitCircle.tint = 0xdedede;
            this.sliderTail.hitCircle.tint = 0xdedede;
        }

        this.sliderHead.hitCircle.tint = colors[idx % colors.length];
        this.sliderTail.hitCircle.tint = colors[idx % colors.length];
    }

    createArc(side, length) {
        side /= Math.abs(side);

        const indices = [];
        const dist = [];

        const center = [0.0, 0.0];
        const RESOLUTION = 400;

        for (let i = 0; i < RESOLUTION; i++) {
            const angle = (i / RESOLUTION) * Math.PI * side;
            const angleNext = ((i + 1) / RESOLUTION) * Math.PI * side;
            indices.push(
                ...center,
                this.radius * Math.sin(angle),
                this.radius * Math.cos(angle),
                this.radius * Math.sin(angleNext),
                this.radius * Math.cos(angleNext)
            );
            dist.push(0.0, 1.0, 1.0);
        }

        const geometry = new PIXI.Geometry().addAttribute("position", indices, 2).addAttribute("dist", dist, 1);
        return geometry;
    }

    createLine(length) {
        const indices = [
            this.x,
            this.radius,
            this.x + length,
            this.radius,
            this.x,
            0.0,
            this.x,
            0.0,
            this.x + length,
            this.radius,
            this.x + length,
            0.0,
            this.x,
            0.0,
            this.x + length,
            0.0,
            this.x,
            -this.radius,
            this.x,
            -this.radius,
            this.x + length,
            0.0,
            this.x + length,
            -this.radius,
        ];

        const dist = [1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0];

        const geometry = new PIXI.Geometry().addAttribute("position", indices, 2).addAttribute("dist", dist, 1);
        return geometry;
    }
}
