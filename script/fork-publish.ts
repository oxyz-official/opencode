#!/usr/bin/env bun

// Fork-specific publish script.
// Mirrors upstream script/publish.ts but skips Docker, AUR, and Homebrew.
// See the original for reference.

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { fileURLToPath } from "url"

console.log("=== fork publish ===\n")
console.log("version:", Script.version)
console.log("channel:", Script.channel)
console.log("preview:", Script.preview)

// ---------- 1. Update versions across all package.json files ----------
// (same as upstream script/publish.ts lines 37-48)
const pkgjsons = await Array.fromAsync(
  new Bun.Glob("**/package.json").scan({
    absolute: true,
  }),
).then((arr) => arr.filter((x) => !x.includes("node_modules") && !x.includes("dist")))

for (const file of pkgjsons) {
  let pkg = await Bun.file(file).text()
  pkg = pkg.replaceAll(/"version": "[^"]+"/g, `"version": "${Script.version}"`)
  console.log("updated:", file)
  await Bun.file(file).write(pkg)
}

await $`bun install`

// ---------- 2. Build SDK ----------
// (same as upstream script/publish.ts line 58)
await import(`../packages/sdk/js/script/build.ts`)

// ---------- 3. Publish CLI (npm only) ----------
// Replicates packages/opencode/script/publish.ts lines 1-50,
// skipping Docker (line 52-56), AUR (lines 59-114), and Homebrew (lines 116-181).
console.log("\n=== cli ===\n")
{
  const cliDir = fileURLToPath(new URL("../packages/opencode", import.meta.url))
  process.chdir(cliDir)

  const pkg = await import("../packages/opencode/package.json").then((m) => m.default)

  const binaries: Record<string, string> = {}
  for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
    const p = await Bun.file(`./dist/${filepath}`).json()
    binaries[p.name] = p.version
  }
  console.log("binaries", binaries)
  const version = Object.values(binaries)[0]

  await $`mkdir -p ./dist/${pkg.name}`
  await $`cp -r ./bin ./dist/${pkg.name}/bin`
  await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
  await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("../../LICENSE").text())

  await Bun.file(`./dist/${pkg.name}/package.json`).write(
    JSON.stringify(
      {
        name: pkg.name + "-ai",
        bin: {
          [pkg.name]: `./bin/${pkg.name}`,
        },
        scripts: {
          postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
        },
        version: version,
        license: pkg.license,
        optionalDependencies: binaries,
      },
      null,
      2,
    ),
  )

  const tasks = Object.entries(binaries).map(async ([name]) => {
    if (process.platform !== "win32") {
      await $`chmod -R 755 .`.cwd(`./dist/${name}`)
    }
    await $`bun pm pack`.cwd(`./dist/${name}`)
    await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(`./dist/${name}`)
  })
  await Promise.all(tasks)
  await $`cd ./dist/${pkg.name} && bun pm pack && npm publish *.tgz --access public --tag ${Script.channel}`
}

// ---------- 4. Publish SDK ----------
// (same as upstream script/publish.ts line 79)
console.log("\n=== sdk ===\n")
await import(`../packages/sdk/js/script/publish.ts`)

// ---------- 5. Publish Plugin ----------
// (same as upstream script/publish.ts line 82)
console.log("\n=== plugin ===\n")
await import(`../packages/plugin/script/publish.ts`)

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
