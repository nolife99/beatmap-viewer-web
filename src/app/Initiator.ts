import type { Resource } from "./ZipHandler";

const hitsoundFiles = ["drum", "normal", "soft"].flatMap((hitSample) =>
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

async function fetchResources(files: string[], baseUrl: string): Promise<Map<string, Resource>> {
    const resources = new Map<string, Resource>();
    await Promise.all(
        files.map(async (filename) => {
            try {
                const data = await fetch(`${baseUrl}${filename}`).then((r) => r.blob());
                resources.set(filename, data);
            } catch {
                return;
            }
        }),
    );
    return resources;
}

export async function getArgon(): Promise<{ resources: Map<string, Resource>; atlasUrls: string[] }> {
    const resources = await fetchResources(
        ["skin.ini", ...hitsoundFiles],
        "./skinning/argon/",
    );
    return {
        resources,
        atlasUrls: ["./atlas/skins/argon.json"],
    };
}

export async function getDefaultLegacy(): Promise<{ resources: Map<string, Resource>; atlasUrls: string[] }> {
    const resources = await fetchResources(
        ["skin.ini", ...hitsoundFiles],
        "./skinning/legacy/",
    );
    return {
        resources,
        atlasUrls: ["./atlas/skins/legacy.json"],
    };
}

export async function getYugen(): Promise<{ resources: Map<string, Resource>; atlasUrls: string[] }> {
    const resources = await fetchResources(
        ["skin.ini", ...hitsoundFiles],
        "./skinning/yugen/",
    );
    return {
        resources,
        atlasUrls: ["./atlas/skins/yugen.json"],
    };
}
