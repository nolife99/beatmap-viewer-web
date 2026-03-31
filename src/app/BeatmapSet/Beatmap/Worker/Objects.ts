import IntervalTree, { IntervalBase, Node, type IntervalInput } from "@flatten-js/interval-tree";

type HitObjectMini = {
	startTime: number;
	endTime: number;
	timePreempt: number;
};

const objectsTree = new IntervalTree<number>();
const connectorsTree = new IntervalTree<number>();

let objects: HitObjectMini[] = [];
let connectors: HitObjectMini[] = [];

let currentTime = 0;
let startTime = 0;
let previousTime = 0;
let interval: NodeJS.Timeout;

let preempt = 1200;

let playbackRate = 1;

function getCurrentTime() {
	return currentTime + (performance.now() - startTime) * playbackRate;
}

function loop() {
	if (objects.length === 0) return;

	const currentTime = getCurrentTime();
	const _objects = findRange(objectsTree, currentTime);
	const _connectors = findRange(connectorsTree, currentTime);

	postMessage({
		type: "update",
		objects: _objects,
		connectors: _connectors,
		currentTime,
		previousTime,
	});

	previousTime = currentTime;
}

const nodeStack: Node<number>[] = [];
const stateStack: number[] = [];

function findRange(tree: IntervalTree<number>, time: number) {
	const res = new Set<number>();

	const node = tree.root;
	if (node == null || node === tree.nil_node)
		return res;

	nodeStack.push(node);
	stateStack.push(0);

	const search_node = new Node([time - 800, time + preempt]);
	while (nodeStack.length > 0) {
		const current = nodeStack[nodeStack.length - 1];
		const state = stateStack[stateStack.length - 1];

		if (current === tree.nil_node) {
			nodeStack.pop();
			stateStack.pop();
			continue;
		}

		if (state === 0) {
			stateStack[stateStack.length - 1] = 1;

			const shouldGoLeft = current.left !== tree.nil_node &&
				!current.not_intersect_left_subtree(search_node);
			if (shouldGoLeft) {
				nodeStack.push(current.left!);
				stateStack.push(0);
			}
		} else if (state === 1) {
			// Left done - process current node
			if (current.intersect(search_node))
				for (const v of current.item.values)
					res.add(v);

			stateStack[stateStack.length - 1] = 2;

			const shouldGoRight = current.right !== tree.nil_node &&
				!current.not_intersect_right_subtree(search_node);
			if (shouldGoRight) {
				nodeStack.push(current.right!);
				stateStack.push(0);
			}
		} else {
			nodeStack.pop();
			stateStack.pop();
		}
	}

	nodeStack.length = 0;
	stateStack.length = 0;
	
	return res;
}

function initTree(tree: IntervalTree, objects: HitObjectMini[]) {
	tree.clear();

	objects.forEach((object, i) =>
		tree.insert([object.startTime, (object.endTime ?? object.startTime) + 800], i));
}

// biome-ignore lint/suspicious/noGlobalAssign: Shut!
onmessage = (event) => {
	switch (event.data.type) {
		case "init": {
			objects = event.data.objects;
			connectors = event.data.connectors;

			initTree(objectsTree, objects);
			initTree(connectorsTree, connectors);

			loop();
			break;
		}
		case "preempt": {
			preempt = event.data.preempt;
			break;
		}
		case "start": {
			startTime = performance.now();

			interval = setInterval(loop);
			break;
		}
		case "stop": {
			currentTime += (performance.now() - startTime) * playbackRate;

			clearInterval(interval);
			break;
		}
		case "seek": {
			currentTime = event.data.time;
			startTime = performance.now();

			loop();
			break;
		}
		case "destroy": {
			clearInterval(interval);
			close();
			break;
		}
		case "playbackRate": {
			playbackRate = event.data.playbackRate;
			break;
		}
	}
};