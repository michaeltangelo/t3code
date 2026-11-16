const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

async function main() {
  const modulePath = require.resolve("electron/package.json");
  const electronDir = path.dirname(modulePath);
  if (!existsSync(path.join(electronDir, "path.txt"))) {
    const install = spawn(process.execPath, [path.join(electronDir, "install.js")], {
      stdio: "inherit",
    });
    const code = await new Promise((resolve) => install.on("exit", resolve));
    if (code !== 0) throw new Error("Electron runtime installation failed.");
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [__dirname, ...process.argv.slice(2)], {
    env,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
