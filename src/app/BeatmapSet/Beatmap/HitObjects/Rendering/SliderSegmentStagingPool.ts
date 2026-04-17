import typedarraypool from "@stdlib/array-pool";
import {Ticker, UPDATE_PRIORITY} from "pixi.js";

const inFlight: Float32Array[] = [];
let releaseScheduled = false;

export function acquireSegmentStagingBuffer(requiredFloats: number): Float32Array {
    const arr = typedarraypool(requiredFloats, "float32") as Float32Array;
    inFlight.push(arr);
    return arr;
}

export function scheduleSegmentStagingRelease() {
    if (releaseScheduled) return;
    releaseScheduled = true;

    Ticker.shared.addOnce(() => {
        for (const arr of inFlight)
            typedarraypool.free(arr);

        inFlight.length = 0;
        releaseScheduled = false;
    }, undefined, UPDATE_PRIORITY.UTILITY);
}