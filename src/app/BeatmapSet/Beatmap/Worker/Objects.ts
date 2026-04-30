import IntervalTree, { type IntervalInput, Node } from '@flatten-js/interval-tree';
import {
	CLOCK_BIG_AUDIO_POS,
	CLOCK_INT_PLAYING,
	CLOCK_INT_SEQNO
} from '../../../Audio/RingBuffer.ts';

type HitObjectMini = {
	startTime: number;
	endTime: number;
	timePreempt: number;
};

type WorkerInMessage =
	| {
	type: 'init';
	objects: HitObjectMini[];
	connectors: HitObjectMini[];
}
	| { type: 'clock'; sabClock: SharedArrayBuffer }
	| { type: 'preempt'; preempt: number }
	| { type: 'start' }
	| { type: 'stop' }
	| { type: 'seek'; time: number }
	| { type: 'destroy' }
	| { type: 'playbackRate'; playbackRate: number };

const objectsTree = new IntervalTree<number>();
const connectorsTree = new IntervalTree<number>();

const nodeStack: Node<number>[] = [];
const stateStack: number[] = [];

let objects: HitObjectMini[] = [];
let connectors: HitObjectMini[] = [];

let clockInt: Int32Array | null = null;
let clockBig: BigInt64Array | null = null;

let timer: number | undefined;
let preempt = 1200;
let playbackRate = 1;

let anchorTime = 0;
let anchorPerf = performance.now();
let previousTime = 0;

function readClockMs(): number | null {
	if (!clockInt || !clockBig) return null;
	if (Atomics.load(clockInt, CLOCK_INT_PLAYING) !== 1) return null;

	for (let i = 0; i < 8; i++) {
		const seq1 = Atomics.load(clockInt, CLOCK_INT_SEQNO);
		if (seq1 & 1) continue;

		const micros = Number(Atomics.load(clockBig, CLOCK_BIG_AUDIO_POS));
		const seq2 = Atomics.load(clockInt, CLOCK_INT_SEQNO);

		if (seq1 === seq2) return micros / 1000;
	}

	return null;
}

function nowMs(): number {
	const clock = readClockMs();

	if (clock !== null) {
		anchorTime = clock;
		anchorPerf = performance.now();
		return clock;
	}

	return anchorTime + (performance.now() - anchorPerf) * playbackRate;
}

function resetClock(time = nowMs()): void {
	anchorTime = time;
	anchorPerf = performance.now();
	previousTime = time;
}

function loop(): void {
	if (objects.length === 0) return;

	const currentTime = nowMs();
	const prev = previousTime || currentTime;

	const visibleInterval = [currentTime - 800, currentTime + preempt] as IntervalInput;
	postMessage({
		type: 'update',
		objects: findRange(objectsTree, visibleInterval),
		connectors: findRange(connectorsTree, visibleInterval),
		currentTime,
		previousTime: prev
	});

	previousTime = currentTime;
}

function initTree(tree: IntervalTree<number>, items: HitObjectMini[]): void {
	tree.clear();

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		tree.insert([item.startTime, (item.endTime ?? item.startTime) + 800], i);
	}
}

export function findRange(tree: IntervalTree<number>, interval: IntervalInput): Set<number> {
	const result = new Set<number>();
	const root = tree.root;

	if (root == null || root === tree.nil_node) return result;

	const searchNode = new Node(interval);

	nodeStack.push(root);
	stateStack.push(0);

	while (nodeStack.length > 0) {
		const node = nodeStack[nodeStack.length - 1];
		const state = stateStack[stateStack.length - 1];

		if (node === tree.nil_node) {
			nodeStack.pop();
			stateStack.pop();
			continue;
		}

		if (state === 0) {
			stateStack[stateStack.length - 1] = 1;

			if (
				node.left !== tree.nil_node &&
				!node.not_intersect_left_subtree(searchNode)
			) {
				nodeStack.push(node.left!);
				stateStack.push(0);
			}

			continue;
		}

		if (state === 1) {
			if (node.intersect(searchNode)) {
				for (const value of node.item.values) result.add(value);
			}

			stateStack[stateStack.length - 1] = 2;

			if (
				node.right !== tree.nil_node &&
				!node.not_intersect_right_subtree(searchNode)
			) {
				nodeStack.push(node.right!);
				stateStack.push(0);
			}

			continue;
		}

		nodeStack.pop();
		stateStack.pop();
	}

	nodeStack.length = 0;
	stateStack.length = 0;

	return result;
}

onmessage = (event: MessageEvent<WorkerInMessage>) => {
	const msg = event.data;

	switch (msg.type) {
		case 'init':
			objects = msg.objects;
			connectors = msg.connectors;
			initTree(objectsTree, objects);
			initTree(connectorsTree, connectors);
			loop();
			break;

		case 'clock':
			clockInt = new Int32Array(msg.sabClock, 0, 4);
			clockBig = new BigInt64Array(msg.sabClock, 16, 2);
			resetClock();
			loop();
			break;

		case 'preempt':
			preempt = msg.preempt;
			break;

		case 'start':
			if (timer !== undefined) clearInterval(timer);
			resetClock();
			timer = setInterval(loop);
			loop();
			break;

		case 'stop':
			anchorTime = nowMs();
			anchorPerf = performance.now();

			if (timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}

			loop();
			break;

		case 'seek':
			resetClock(msg.time);
			loop();
			break;

		case 'playbackRate':
			anchorTime = nowMs();
			anchorPerf = performance.now();
			playbackRate = msg.playbackRate;
			break;

		case 'destroy':
			if (timer !== undefined) clearInterval(timer);
			close();
			break;
	}
};