import type { Resource } from "./ZipHandler";

async function tryFetchBlob(url: string): Promise<Blob | null> {
    try {
        const res = await fetch(url);

        // ky throws on non-2xx — replicate behavior
        if (!res.ok) return null;

        return await res.blob();
    } catch {
        return null;
    }
}

async function loadSkinResources(
    basePath: string,
    filenames: readonly string[],
): Promise<Map<string, Resource>> {

    const resources = new Map<string, Resource>();

    await Promise.all(
        filenames.map(async (filename) => {
            const blob = await tryFetchBlob(`${basePath}/${filename}`);
            if (blob) resources.set(filename, blob);
        }),
    );

    return resources;
}

function buildDefaults(): string[] {
    const defaults = Array.from({ length: 10 }, (_, idx) => `default-${idx}@2x.png`);

    const hitSounds = ["drum", "normal", "soft"].flatMap((hitSample) =>
        [
            "hitclap",
            "hitfinish",
            "hitnormal",
            "hitwhistle",
            "sliderslide",
            "slidertick",
            "sliderwhistle",
        ].map((hitSound) => `${hitSample}-${hitSound}.wav`),
    );

    return [...defaults, ...hitSounds];
}

export async function getArgon() {

    const filenames = [
        ...buildDefaults(),
        "followpoint.png",
        "timelinehitcircle@2x.png",
        "hit300@2x.png",
        "hit100@2x.png",
        "hit50@2x.png",
        "hit0@2x.png",
        "hitcircle@2x.png",
        "hitcircleflash@2x.png",
        "hitcircleglow@2x.png",
        "hitcircleoverlay@2x.png",
        "hitcircleselect@2x.png",
        "sliderb@2x.png",
        "sliderb-nd@2x.png",
        "sliderfollowcircle@2x.png",
        "reversearrow@2x.png",
        "repeat-edge-piece@2x.png",
        "sliderendcircle.png",
        "sliderstartcircle@2x.png",
        "sliderscorepoint@2x.png",
        "spinner-approachcircle@2x.png",
        "spinner-bottom@2x.png",
        "skin.ini",
    ];

    return loadSkinResources("./skinning/argon", filenames);
}

export async function getDefaultLegacy() {

    const filenames = [
        "approachcircle@2x.png",
        ...buildDefaults(),
        "cursor@2x.png",
        "cursortrail.png",
        "followpoint@2x.png",
        "hit300@2x.png",
        "hit100@2x.png",
        "hit50@2x.png",
        "hit0@2x.png",
        "hitcircle@2x.png",
        "hitcircleoverlay@2x.png",
        "hitcircleselect@2x.png",
        "skin.ini",
        "sliderb0@2x.png",
        "sliderb1@2x.png",
        "sliderb2@2x.png",
        "sliderb3@2x.png",
        "sliderb4@2x.png",
        "sliderb5@2x.png",
        "sliderb6@2x.png",
        "sliderb7@2x.png",
        "sliderb8@2x.png",
        "sliderb9@2x.png",
        "sliderb-nd@2x.png",
        "sliderb-spec@2x.png",
        "sliderfollowcircle@2x.png",
        "reversearrow@2x.png",
        "sliderscorepoint@2x.png",
        "spinner-approachcircle@2x.png",
        "spinner-bottom@2x.png",
    ];

    return loadSkinResources("./skinning/legacy", filenames);
}

export async function getYugen() {

    const filenames = [
        "approachcircle.png",
        "cursor@2x.png",
        "cursortrail.png",
        ...buildDefaults(),
        "followpoint@2x.png",
        "followpoint-0.png",
        "followpoint-1.png",
        "followpoint-2.png",
        "hit300.png",
        "hit100.png",
        "hit50.png",
        "hit0.png",
        "hitcircle@2x.png",
        "hitcircleoverlay@2x.png",
        "skin.ini",
        "sliderb0@2x.png",
        "sliderfollowcircle@2x.png",
        "reversearrow@2x.png",
        "sliderscorepoint.png",
        "spinner-approachcircle@2x.png",
        "spinner-bottom@2x.png",
    ];

    return loadSkinResources("./skinning/yugen", filenames);
}