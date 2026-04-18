import type BeatmapSet from "@/BeatmapSet";
import type AudioConfig from "@/Config/AudioConfig";
import { inject, ScopedClass } from "../Context";
import SpectrogramProcessor from "./SpectrogramProcessor";

import { SoundTouchNode } from "@soundtouchjs/audio-worklet";

const audioContext = new AudioContext;
await SoundTouchNode.register(audioContext, '/soundtouch-processor.js');

export function getAudioContext() {
    return audioContext;
}

export default class Audio extends ScopedClass {
    private localGainNode: GainNode;
    private previousTimestamp = 0;
    private _currentTime = 0;
    private startTime = 0;

    private audioBuffer?: AudioBuffer;
    private sourceNode?: AudioBufferSourceNode;
    private soundTouchNode?: SoundTouchNode;

    state: "PLAYING" | "STOPPED" = "STOPPED";
    init = false;

    constructor(private masterNode: AudioNode) {
        super();

        this.localGainNode = masterNode.context.createGain();
        this.localGainNode.gain.value =
            inject<AudioConfig>("config/audio")?.musicVolume ?? 0.8;

        inject<AudioConfig>("config/audio")?.onChange("musicVolume", (val) => {
            this.localGainNode.gain.value = val;
        });
    }

    get playbackRate() {
        return this.context.consume<BeatmapSet>("beatmapset")?.playbackRate ?? 1;
    }

    private desyncedFrames = 0;

    get currentTime() {
        if (this.state === "STOPPED") return this._currentTime;

        const now =
            this._currentTime +
            (performance.now() - this.previousTimestamp) * this.playbackRate;

        const offset =
            (performance.now() -
                this.previousTimestamp -
                (this.masterNode.context.currentTime * 1000 - this.startTime)) *
            this.playbackRate;

        if (Math.abs(offset) > 10) this.desyncedFrames++;
        else this.desyncedFrames = 0;

        if (this.desyncedFrames > 30) {
            this.context.consume<BeatmapSet>("beatmapset")?.seek(now);
            this.desyncedFrames = 0;
            console.warn(`Audio desynced: ${offset.toFixed()}ms`);
        }

        if (now > this.duration) {
            if (this.state === "PLAYING") {
                this.context.consume<BeatmapSet>("beatmapset")?.toggle();
                this.context.consume<BeatmapSet>("beatmapset")?.seek(0);
            }
            return this.duration;
        }

        return now;
    }

    set currentTime(val: number) {
        const previousState = this.state;

        if (previousState === "PLAYING") this.pause();

        this._currentTime =
            val > (this.audioBuffer?.duration ?? 0) * 1000 || val < 0
                ? 0
                : val;

        if (previousState === "PLAYING") this.play();
    }

    async createBufferNode(blob: Blob) {
        const ctx = this.masterNode.context;

        const data = await ctx.decodeAudioData(await blob.arrayBuffer());
        this.audioBuffer = data;

        new SpectrogramProcessor(data);

        const sizePerChannel = data.length * 4 / (1024 * 1024);
        const sizeMb = sizePerChannel * data.numberOfChannels;

        console.log(`Audio buffer size: ${sizeMb.toFixed()}MB (${sizePerChannel.toFixed()}MB per channel)`);

        this.init = true;
    }

    toggle() {
        if (this.state === "PLAYING") {
            this.pause();
            return;
        }
        this.play();
    }

    play() {
        if (this.state === "PLAYING")
            throw new Error("Already playing");

        if (!this.audioBuffer)
            throw new Error("Audio not initialized");

        this.state = "PLAYING";

        const ctx = this.masterNode.context;

        this.sourceNode = ctx.createBufferSource();
        this.sourceNode.buffer = this.audioBuffer;
        this.sourceNode.loop = false;

        let offsetSec = this._currentTime / 1000;
        
        if (this.playbackRate !== 1) {
            this.soundTouchNode = new SoundTouchNode(ctx);
            this.sourceNode.playbackRate.value = this.playbackRate;
            this.soundTouchNode.playbackRate.value = this.playbackRate;
            this.soundTouchNode.pitch.value = 1;
    
            this.sourceNode.connect(this.soundTouchNode);
            this.soundTouchNode.connect(this.localGainNode);
        }
        else {
            this.sourceNode.connect(this.localGainNode);
        }
        
        this.localGainNode.connect(this.masterNode);
        this.sourceNode.start(0, offsetSec);

        this.startTime = ctx.currentTime * 1000;
        this.previousTimestamp = performance.now();

        this.sourceNode.onended = () => {
            if (this.state === "PLAYING") {
                this.context.consume<BeatmapSet>("beatmapset")?.toggle();
                this.context.consume<BeatmapSet>("beatmapset")?.seek(0);
            }
        };
    }

    pause() {
        if (this.state === "STOPPED")
            throw new Error("Already stopped");

        this.state = "STOPPED";

        this._currentTime +=
            (performance.now() - this.previousTimestamp) * this.playbackRate;

        if (this.sourceNode) {
            this.sourceNode.onended = null;
            this.sourceNode.stop();
            this.sourceNode.disconnect();
            this.sourceNode = undefined;
        }
        if (this.soundTouchNode) {
            this.soundTouchNode.disconnect();
            this.soundTouchNode = undefined;
        }
        this.localGainNode.disconnect();
    }

    get duration() {
        return (this.audioBuffer?.duration ?? 0) * 1000;
    }

    destroy() {
        if (this.state === "PLAYING") this.pause();
        this.audioBuffer = undefined;
        this.init = false;
    }
}