#!/usr/bin/env bun

// Fork-specific publish script.
// Mirrors upstream script/publish.ts but skips Docker, AUR, and Homebrew,
// and scopes all package names under OPENCODE_NPM_SCOPE (e.g. @ofoundation).
//
// Source files (build.ts, bin/opencode, postinstall.mjs) are NOT modified to
// avoid merge conflicts on upstream sync. Instead, this script patches names
// in the dist copies at publish time.

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { fileURLToPath } from "url"

const scope = process.env.OPENCODE_NPM_SCOPE || ""
const scopePrefix = scope ? `@${scope}/` : ""

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

// ---------- 3. Publish CLI (npm only, scoped) ----------
// Replicates packages/opencode/script/publish.ts lines 1-50,
// skipping Docker (line 52-56), AUR (lines 59-114), and Homebrew (lines 116-181).
// Adds npm scope to all package names.
console.log("\n=== cli ===\n")
{
  const cliDir = fileURLToPath(new URL("../packages/opencode", import.meta.url))
  process.chdir(cliDir)

  const pkg = await import("../packages/opencode/package.json").then((m) => m.default)

  const binaries: Record<string, string> = {}
  for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
    const p = await Bun.file(`./dist/${filepath}`).json()
    const scoped = `${scopePrefix}${p.name}`
    p.name = scoped
    await Bun.file(`./dist/${filepath}`).write(JSON.stringify(p, null, 2))
    binaries[scoped] = p.version
    console.log(`scoped: ${filepath} -> ${scoped}`)
  }
  console.log("binaries", binaries)
  const version = Object.values(binaries)[0]

  // Build wrapper package
  const wrapperName = scope ? `@${scope}/opencode` : `${pkg.name}-ai`
  await $`mkdir -p ./dist/${pkg.name}`
  await $`cp -r ./bin ./dist/${pkg.name}/bin`
  await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
  await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("../../LICENSE").text())

  // Patch the copied bin/opencode to resolve scoped package names
  if (scope) {
    const binScript = `./dist/${pkg.name}/bin/${pkg.name}`
    let bin = await Bun.file(binScript).text()
    // bin/opencode line 53: const base = "opencode-" + platform + "-" + arch
    bin = bin.replace(
      `const base = "opencode-" + platform + "-" + arch`,
      `const base = "${scopePrefix}opencode-" + platform + "-" + arch`,
    )
    // bin/opencode line 52: const packageName = \`opencode-\${platform}-\${arch}\`
    // (postinstall.mjs uses the same pattern but is a separate file)
    await Bun.file(binScript).write(bin)
    console.log(`patched: ${binScript}`)

    // Patch the copied postinstall.mjs to resolve scoped package names
    const postinstall = `./dist/${pkg.name}/postinstall.mjs`
    let pi = await Bun.file(postinstall).text()
    pi = pi.replace(
      "const packageName = `opencode-${platform}-${arch}`",
      `const packageName = \`${scopePrefix}opencode-\${platform}-\${arch}\``,
    )
    await Bun.file(postinstall).write(pi)
    console.log(`patched: ${postinstall}`)
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

  // Publish each binary package
  // Binary dist dirs are still named opencode-* (build.ts output), but
  // their package.json name is now @scope/opencode-*
  const dirs = Object.keys(binaries).map((scoped) => scoped.replace(scopePrefix, ""))
  const tasks = dirs.map(async (dir) => {
    if (process.platform !== "win32") {
      await $`chmod -R 755 .`.cwd(`./dist/${dir}`)
    }
    await $`bun pm pack`.cwd(`./dist/${dir}`)
    await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(`./dist/${dir}`)
  })
  await Promise.all(tasks)

  // Publish wrapper package
  await $`cd ./dist/${pkg.name} && bun pm pack && npm publish *.tgz --access public --tag ${Script.channel}`
}

// ---------- 4. Publish SDK ----------
// Inlined from packages/sdk/js/script/publish.ts to control scoped name.
// Upstream uses @opencode-ai/sdk; fork publishes as @scope/opencode-sdk.
console.log("\n=== sdk ===\n")
{
  const sdkDir = fileURLToPath(new URL("../packages/sdk/js", import.meta.url))
  process.chdir(sdkDir)

  const pkg = await Bun.file("package.json").json()
  const original = JSON.parse(JSON.stringify(pkg))

  if (scope) {
    pkg.name = `@${scope}/opencode-sdk`
  }

  function transformExports(exports: Record<string, string | object>) {
    for (const [key, value] of Object.entries(exports)) {
      if (typeof value === "object" && value !== null) {
        transformExports(value as Record<string, string | object>)
      } else if (typeof value === "string") {
        const file = value.replace("./src/", "./dist/").replace(".ts", "")
        exports[key] = {
          import: file + ".js",
          types: file + ".d.ts",
        }
      }
    }
  }
  transformExports(pkg.exports)
  await Bun.write("package.json", JSON.stringify(pkg, null, 2))
  await $`bun pm pack`
  await $`npm publish *.tgz --tag ${Script.channel} --access public`
  await Bun.write("package.json", JSON.stringify(original, null, 2))
}

// ---------- 5. Publish Plugin ----------
// Inlined from packages/plugin/script/publish.ts to control scoped name.
// Upstream uses @opencode-ai/plugin; fork publishes as @scope/opencode-plugin.
console.log("\n=== plugin ===\n")
{
  const pluginDir = fileURLToPath(new URL("../packages/plugin", import.meta.url))
  process.chdir(pluginDir)

  await $`bun tsc`
  const pkg = await Bun.file("package.json").json()
  const original = JSON.parse(JSON.stringify(pkg))

  if (scope) {
    pkg.name = `@${scope}/opencode-plugin`
    if (pkg.dependencies?.["@opencode-ai/sdk"]) {
      pkg.dependencies[`@${scope}/opencode-sdk`] = pkg.dependencies["@opencode-ai/sdk"]
      delete pkg.dependencies["@opencode-ai/sdk"]
    }
  }

  for (const [key, value] of Object.entries(pkg.exports)) {
    const file = (value as string).replace("./src/", "./dist/").replace(".ts", "")
    pkg.exports[key] = {
      import: file + ".js",
      types: file + ".d.ts",
    }
  }
  await Bun.write("package.json", JSON.stringify(pkg, null, 2))
  await $`bun pm pack && npm publish *.tgz --tag ${Script.channel} --access public`
  await Bun.write("package.json", JSON.stringify(original, null, 2))
}

const rootDir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(rootDir)
