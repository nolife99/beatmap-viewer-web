import * as Tone from "tone";
import type BeatmapSet from "@/BeatmapSet";
import type AudioConfig from "@/Config/AudioConfig";
import { inject, ScopedClass } from "../Context";
import SpectrogramProcessor from "./SpectrogramProcessor";

export default class Audio extends ScopedClass {
	private localGainNode: GainNode;
	private previousTimestamp = 0;
	private _currentTime = 0;
	private startTime = 0;

	player?: Tone.Player | Tone.GrainPlayer;
	normalPlayer?: Tone.Player;
	grainPlayer?: Tone.GrainPlayer;

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

		this.lookahead = 0.1;
	}

	get playbackRate() {
		return this.context.consume<BeatmapSet>("beatmapset")?.playbackRate ?? 1;
	}

	private desyncedFrames = 0;
	get currentTime() {
		if (this.state === "STOPPED") return this._currentTime;

		const now = this._currentTime +
			(performance.now() - this.previousTimestamp) * this.playbackRate;
		const offset =
			(performance.now() -
			this.previousTimestamp -
			(this.masterNode.context.currentTime * 1000 - this.startTime)) * this.playbackRate;

		if (Math.abs(offset) > 10) this.desyncedFrames++;
		else this.desyncedFrames = 0;

		if (this.desyncedFrames > 2) {
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
		if (!this.player) throw new Error("You haven't initiated audio yet!");
		const previousState = this.state;

		if (previousState === "PLAYING") {
			this.pause();
		}

		this._currentTime =
			val > this.player.buffer.duration * 1000 || val < 0 ? 0 : val;

		Tone.getTransport().seconds =
			this._currentTime / 1000 / this.playbackRate + this.lookahead;

		if (previousState === "PLAYING") {
			this.play();
		}
	}

	async createBufferNode(blob: Blob) {
		const data = await Tone.getContext().decodeAudioData(await blob.arrayBuffer());
		new SpectrogramProcessor(data);

		this.grainPlayer = new Tone.GrainPlayer(data);
		this.normalPlayer = new Tone.Player(data);

		this.player = this.normalPlayer;
		this.player.sync().start(0);

		const sizeMb = data.length * data.numberOfChannels * 4 / (1024 * 1024);
		const sizePerChannel = data.length * 4 / (1024 * 1024);

		console.log(`Audio buffer size: ${sizeMb.toFixed()}MB (~${sizePerChannel.toFixed()}MB per channel)`);

		Tone.getTransport().seconds = this.lookahead;

		this.init = true;
	}

	private _lookahead = 0.1;
	get lookahead() {
		return this._lookahead;
	}

	set lookahead(val: number) {
		this._lookahead = val;
		Tone.getContext().lookAhead = val;
	}

	toggle() {
		if (this.state === "PLAYING") {
			this.pause();
			return;
		}

		const playbackRate =
			this.context.consume<BeatmapSet>("beatmapset")?.playbackRate ?? 1;

		this.player = playbackRate !== 1 ? this.grainPlayer : this.normalPlayer;

		if (this.grainPlayer) {
			const baseWindow =
				60000 /
				(this.context.consume<BeatmapSet>("beatmapset")?.master?.data.bpm ??
					120) /
				2 /
				1000;

			this.grainPlayer.playbackRate = playbackRate;
			this.grainPlayer.grainSize = baseWindow;
			this.grainPlayer.overlap = baseWindow / 16;
		}

		if (this.state === "STOPPED") {
			this.currentTime;
			this.play();

			return;
		}
	}

	play() {
		if (this.state === "PLAYING")
			throw new Error("You cannot start an already started audio!");
		if (!this.player) throw new Error("You haven't initiated audio yet!");
		this.state = "PLAYING";

		Tone.getTransport().seconds =
			this._currentTime / 1000 / this.playbackRate + this.lookahead;

		this.startTime = this.masterNode.context.currentTime * 1000;

		this.player?.unsync();
		this.player?.sync().start(0);
		Tone.getTransport().start();

		this.player?.connect(this.localGainNode);
		this.localGainNode.connect(this.masterNode);

		this.previousTimestamp = performance.now();
	}

	pause() {
		if (this.state === "STOPPED")
			throw new Error("You cannot stop an already stopped audio!");
		if (!this.player) throw new Error("You haven't initiated audio yet!");
		this.state = "STOPPED";

		Tone.getTransport().pause();
		this._currentTime +=
			(performance.now() - this.previousTimestamp) * this.playbackRate;

		Tone.disconnect(this.player);
		this.localGainNode.disconnect();
	}

	get duration() {
		return (this.player?.buffer.duration ?? 0) * 1000;
	}

	destroy() {
		this.grainPlayer?.dispose();
		this.normalPlayer?.dispose();
	}
}
