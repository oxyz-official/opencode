#!/usr/bin/env bun

// Fork-specific publish script.
// Mirrors upstream script/publish.ts but skips Docker, AUR, and Homebrew,
// and optionally scopes all package names under NPM_SCOPE.

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { fileURLToPath } from "url"
import path from "path"

const rootDir = fileURLToPath(new URL("..", import.meta.url))
const scope = process.env.NPM_SCOPE?.replace(/^@/, "") || ""
const prefix = scope ? `@${scope}/` : ""

console.log("=== fork publish ===\n")
console.log("version:", Script.version)
console.log("channel:", Script.channel)
console.log("preview:", Script.preview)
console.log("scope:", scope || "(none)")

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

  // Collect binaries from build output and optionally rewrite names
  const binaries: Record<string, string> = {}
  for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
    const p = await Bun.file(`./dist/${filepath}`).json()
    if (prefix) {
      p.name = prefix + p.name
      await Bun.file(`./dist/${filepath}`).write(JSON.stringify(p, null, 2))
    }
    binaries[p.name] = p.version
  }
  console.log("binaries", binaries)
  const version = Object.values(binaries)[0]

  // Build wrapper package
  const wrapperName = prefix ? `${prefix}opencode` : `${pkg.name}-ai`
  await $`mkdir -p ./dist/${pkg.name}`
  await $`cp -r ./bin ./dist/${pkg.name}/bin`
  await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
  await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("../../LICENSE").text())

  // Rewrite bin/opencode to resolve scoped package names
  if (prefix) {
    const binPath = `./dist/${pkg.name}/bin/opencode`
    let bin = await Bun.file(binPath).text()
    bin = bin.replace(
      '"opencode-" + platform + "-" + arch',
      `"${prefix}opencode-" + platform + "-" + arch`,
    )
    await Bun.file(binPath).write(bin)

    const postinstallPath = `./dist/${pkg.name}/postinstall.mjs`
    let postinstall = await Bun.file(postinstallPath).text()
    postinstall = postinstall.replace(
      "opencode-${platform}-${arch}",
      `${prefix}opencode-\${platform}-\${arch}`,
    )
    await Bun.file(postinstallPath).write(postinstall)
  }

  await Bun.file(`./dist/${pkg.name}/package.json`).write(
    JSON.stringify(
      {
        name: wrapperName,
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

  // Publish all binary packages in parallel (same as upstream)
  const tasks = Object.entries(binaries).map(async ([name]) => {
    const dir = `./dist/${name.replace(prefix, "")}`
    if (process.platform !== "win32") {
      await $`chmod -R 755 .`.cwd(dir)
    }
    await $`bun pm pack`.cwd(dir)
    await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(dir)
  })
  await Promise.all(tasks)

  // Publish wrapper package
  await $`cd ./dist/${pkg.name} && bun pm pack && npm publish *.tgz --access public --tag ${Script.channel}`
}

// ---------- 4. Scope SDK name before publishing ----------
if (prefix) {
  const sdkPkgPath = path.resolve(rootDir, "packages/sdk/js/package.json")
  const sdkPkg = await Bun.file(sdkPkgPath).json()
  sdkPkg.name = `${prefix}opencode-sdk`
  await Bun.file(sdkPkgPath).write(JSON.stringify(sdkPkg, null, 2))
}

console.log("\n=== sdk ===\n")
await import(`../packages/sdk/js/script/publish.ts`)

// ---------- 5. Scope Plugin name and deps before publishing ----------
if (prefix) {
  const pluginPkgPath = path.resolve(rootDir, "packages/plugin/package.json")
  const pluginPkg = await Bun.file(pluginPkgPath).json()
  pluginPkg.name = `${prefix}opencode-plugin`
  if (pluginPkg.dependencies?.["@opencode-ai/sdk"]) {
    pluginPkg.dependencies[`${prefix}opencode-sdk`] = Script.version
    delete pluginPkg.dependencies["@opencode-ai/sdk"]
  }
  await Bun.file(pluginPkgPath).write(JSON.stringify(pluginPkg, null, 2))
}

console.log("\n=== plugin ===\n")
await import(`../packages/plugin/script/publish.ts`)

process.chdir(rootDir)
