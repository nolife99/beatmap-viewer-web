await Deno.remove("dist/server", { recursive: true }).catch(() => {});
await Deno.mkdir("dist/server", { recursive: true });

await Deno.copyFile("src/server/prod.ts", "dist/server/index.ts");

console.log("Copied production server to dist/server/index.ts");