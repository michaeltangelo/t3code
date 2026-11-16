const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

async function main() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "t3-auth-probe-test-"));
  const server = http.createServer((request, response) => {
    if (request.url === "/write") {
      response.setHeader("Set-Cookie", [
        "persistent=synthetic; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600",
        "session=synthetic; HttpOnly; SameSite=Lax; Path=/",
      ]);
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      request.url === "/write"
        ? '<script>localStorage.setItem("probe","synthetic-value")</script>Fixture ready'
        : "Restart fixture",
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const phase of ["write", "read"]) {
      const env = {
        ...process.env,
        AUTH_PROBE_TEST_DATA: data,
        AUTH_PROBE_FIXTURE_ORIGIN: `http://127.0.0.1:${server.address().port}`,
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(
        process.execPath,
        [path.join(__dirname, "launch.cjs"), `--test-phase=${phase}`],
        { env, stdio: "inherit" },
      );
      const code = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", resolve);
      });
      assert.equal(code, 0, `${phase} Electron process must pass`);
      const result = JSON.parse(fs.readFileSync(path.join(data, `${phase}.json`), "utf8"));
      assert.equal(result.passed, true);
      console.log(JSON.stringify(result));
    }
    console.log(
      "PASS: two real Electron processes; persistent HttpOnly cookies, localStorage, and profile isolation checked.",
    );
    console.log("Session-cookie survival is measured, not forced or treated as authenticated.");
  } finally {
    server.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
