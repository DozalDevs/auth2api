import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

import { Config } from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";

const KEY = "sk-plugin-test-0123456789abcdef";
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("pretend this is the rest of a png file"),
]);
const PNG = PNG_BYTES.toString("base64");

async function startImageService(
  reply: (n: number, body: any) => { status: number; body: unknown } = (
    _n,
    b,
  ) => ({
    status: 200,
    body: {
      data: Array.from({ length: b.n || 1 }, () => ({
        b64_json: PNG,
        revised_prompt: "rewritten",
      })),
      output_format: "png",
    },
  }),
) {
  const seen: Array<{ url: string; auth: string | undefined; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url || "", auth: req.headers.authorization, body });
      const r = reply(seen.length, body);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    seen,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}

async function servedPlugin(): Promise<{ text: string; origin: string }> {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-serve-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": [{ name: "a", key: KEY, models: ["*"], admin: true }],
    "body-limit": "1mb",
    cloaking: {},
    timeouts: {
      "messages-ms": 1000,
      "stream-messages-ms": 1000,
      "count-tokens-ms": 1000,
    },
    stats: { enabled: false },
    debug: "off",
  } as Config;
  const server = createServer(config, buildRegistry(authDir)).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((r) => server.once("listening", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${origin}/setup/image-plugin.js`);
    assert.equal(res.status, 200);
    return { text: await res.text(), origin };
  } finally {
    server.close();
    fs.rmSync(authDir, { recursive: true, force: true });
  }
}

interface Loaded {
  tools: Record<string, any>;
  project: string;
  data: string;
  service: Awaited<ReturnType<typeof startImageService>>;
  run: (name: string, input: unknown, signal?: AbortSignal) => Promise<any>;
  permissions: any[];
}

async function load(
  t: test.TestContext,
  opts: { key?: boolean; reply?: Parameters<typeof startImageService>[0] } = {},
): Promise<Loaded> {
  const service = await startImageService(opts.reply);
  t.after(() => service.close());
  const { text } = await servedPlugin();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = fs.realpathSync(
    fs.mkdirSync(path.join(root, "project"), { recursive: true }) ??
      path.join(root, "project"),
  );
  const data = path.join(root, "data");
  fs.mkdirSync(path.join(data, "opencode"), { recursive: true });
  if (opts.key !== false)
    fs.writeFileSync(
      path.join(data, "opencode", "dozaldevs-relay.key"),
      `${KEY}\n`,
    );
  const file = path.join(root, "plugin.mjs");
  fs.writeFileSync(
    file,
    text.replace(/const RELAY = "[^"]*";/, `const RELAY = "${service.url}";`),
  );
  const mod = await import(`${pathToFileURL(file).href}?${Math.random()}`);
  assert.equal(mod.default.id, "dozaldevs.images");
  const tools: Record<string, any> = {};
  const permissions: any[] = [];
  const saved = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = data;
  t.after(() => {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
  });
  mod.default.setup({
    location: { directory: project },
    options: {},
    tool: {
      transform: (cb: any) =>
        cb({ add: (tool: any) => (tools[tool.name] = tool) }),
    },
    permission: { assert: async (p: any) => void permissions.push(p) },
  });
  return {
    tools,
    project,
    data,
    service,
    permissions,
    run: (name, input, signal) =>
      tools[name].execute(input, {
        sessionID: "s",
        agent: "build",
        messageID: "m",
        id: "c",
        signal,
      }),
  };
}

const textOf = (r: any) =>
  r.content.find((c: any) => c.type === "text").text as string;
const filesOf = (r: any) => r.content.filter((c: any) => c.type === "file");

test("the relay serves the plugin with its own address filled in, and it adds the two tools as direct tools", async (t) => {
  const { text, origin } = await servedPlugin();
  assert.ok(text.includes(`const RELAY = "${origin}";`));
  assert.equal(text.includes('__RELAY_URL__";'), false);
  const l = await load(t);
  assert.deepEqual(Object.keys(l.tools).sort(), [
    "edit_image",
    "generate_image",
  ]);
  for (const tool of Object.values(l.tools))
    assert.deepEqual(tool.options, { codemode: false });
  assert.deepEqual(l.tools.generate_image.input.required, ["prompt"]);
  assert.deepEqual(l.tools.edit_image.input.required, [
    "prompt",
    "image_paths",
  ]);
});

test("generate_image sends the saved key, saves the pictures in the project, returns them as attachments, and never overwrites", async (t) => {
  const l = await load(t);
  const r = await l.run("generate_image", {
    prompt: "A red fox, watercolor",
    quality: "high",
    background: "transparent",
    size: "1024x1024",
    filename: "fox",
  });
  assert.equal(l.service.seen[0].url, "/v1/images/generations");
  assert.equal(
    l.service.seen[0].auth,
    `Bearer ${KEY}`,
    "the key from the private file, trimmed",
  );
  assert.deepEqual(l.service.seen[0].body, {
    prompt: "A red fox, watercolor",
    quality: "high",
    background: "transparent",
    size: "1024x1024",
  });
  assert.equal(
    fs
      .readFileSync(path.join(l.project, "generated-images", "fox.png"))
      .equals(PNG_BYTES),
    true,
  );
  assert.match(textOf(r), /Saved generated-images\/fox\.png \(0 KB\)/);
  assert.match(textOf(r), /rewrote the prompt as: rewritten/);
  assert.equal(
    JSON.stringify(r).includes(KEY),
    false,
    "the key is never in a tool result",
  );
  const [file] = filesOf(r);
  assert.equal(file.mime, "image/png");
  assert.equal(file.name, "fox.png");
  assert.equal(file.uri, `data:image/png;base64,${PNG}`);

  const again = await l.run("generate_image", {
    prompt: "A red fox, watercolor",
    filename: "fox",
  });
  assert.match(textOf(again), /generated-images\/fox-1\.png/);
  assert.equal(
    fs.readdirSync(path.join(l.project, "generated-images")).length,
    2,
    "the first picture is still there",
  );

  const many = await l.run("generate_image", {
    prompt: "variations please",
    n: 2,
    filename: "set",
  });
  assert.deepEqual(
    filesOf(many).map((f: any) => f.name),
    ["set-1.png", "set-2.png"],
  );
  assert.equal(l.service.seen[2].body.n, 2);
});

test("file names stay inside the images folder whatever the model asks for", async (t) => {
  const l = await load(t);
  await l.run("generate_image", { prompt: "x", filename: "../../../etc/evil" });
  await l.run("generate_image", {
    prompt: "x",
    filename: "/abs/path/thing.png",
  });
  const dir = path.join(l.project, "generated-images");
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    "abs-path-thing.png",
    "etc-evil.png",
  ]);
  assert.deepEqual(
    fs
      .readdirSync(path.dirname(l.project))
      .filter((n) => n !== "project" && n !== "data" && n !== "plugin.mjs"),
    [],
  );
});

test("edit_image asks permission, reads only real pictures inside the project, and sends them as data URLs", async (t) => {
  const l = await load(t);
  fs.mkdirSync(path.join(l.project, "assets"));
  fs.writeFileSync(path.join(l.project, "assets", "logo.png"), PNG_BYTES);
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from("jpeg-ish"),
  ]);
  fs.writeFileSync(path.join(l.project, "photo.bin"), jpeg);
  const r = await l.run("edit_image", {
    prompt: "make it blue",
    image_paths: ["assets/logo.png", "photo.bin"],
  });
  assert.equal(l.service.seen[0].url, "/v1/images/edits");
  assert.deepEqual(
    l.service.seen[0].body.images,
    [
      `data:image/png;base64,${PNG}`,
      `data:image/jpeg;base64,${jpeg.toString("base64")}`,
    ],
    "the type comes from the bytes, not the file name",
  );
  assert.equal(l.permissions.length, 1);
  assert.equal(l.permissions[0].action, "edit_image");
  assert.deepEqual(l.permissions[0].resources, [
    "assets/logo.png",
    "photo.bin",
  ]);
  assert.equal(filesOf(r).length, 1);
  assert.equal(fs.existsSync(path.join(l.project, "assets", "logo.png")), true);
  assert.equal(
    fs
      .readFileSync(path.join(l.project, "assets", "logo.png"))
      .equals(PNG_BYTES),
    true,
    "the original is untouched",
  );
});

test("edit_image refuses what is not a picture, is outside the project, escapes by symlink, or is too many", async (t) => {
  const l = await load(t);
  const outside = path.join(path.dirname(l.project), "secret.png");
  fs.writeFileSync(outside, PNG_BYTES);
  fs.writeFileSync(path.join(l.project, "notes.txt"), "dear diary");
  fs.symlinkSync(outside, path.join(l.project, "link.png"));
  fs.writeFileSync(path.join(l.project, "ok.png"), PNG_BYTES);
  const refused = async (paths: string[], re: RegExp) => {
    await assert.rejects(
      () => l.run("edit_image", { prompt: "x", image_paths: paths }),
      re,
    );
  };
  await refused(["notes.txt"], /is not a png, jpeg, webp or gif picture/);
  await refused([outside], /outside the project folder/);
  await refused(["../secret.png"], /outside the project folder/);
  await refused(["link.png"], /outside the project folder/);
  await refused(["missing.png"], /There is no file at missing\.png/);
  await refused([], /Give 1 to 5 image paths/);
  await refused(Array(6).fill("ok.png"), /Give 1 to 5 image paths/);
  assert.equal(
    l.service.seen.length,
    0,
    "nothing refused ever left the computer",
  );
});

test("what the person is told when something is wrong is plain and never includes the key", async (t) => {
  const a = await load(t, {
    reply: () => ({
      status: 400,
      body: {
        error: { message: "Your request was rejected by the safety system." },
      },
    }),
  });
  await assert.rejects(
    () => a.run("generate_image", { prompt: "x" }),
    /^Error: Your request was rejected by the safety system\.$/,
  );

  const b = await load(t, {
    reply: () => ({
      status: 401,
      body: { error: { message: "Invalid API key" } },
    }),
  });
  await assert.rejects(
    () => b.run("generate_image", { prompt: "x" }),
    /did not accept your key\. Run the relay setup again/,
  );

  const c = await load(t, {
    reply: () => ({ status: 200, body: { data: [] } }),
  });
  await assert.rejects(
    () => c.run("generate_image", { prompt: "x" }),
    /answered without a picture/,
  );

  const d = await load(t, { key: false });
  await assert.rejects(
    () => d.run("generate_image", { prompt: "x" }),
    /No relay key found on this computer/,
  );
  assert.equal(d.service.seen.length, 0);

  const e = await load(t);
  e.service.close();
  await assert.rejects(
    () => e.run("generate_image", { prompt: "x" }),
    /Could not reach the relay/,
  );
  for (const l of [a, b, c, d, e]) void l;
});

test("cancelling stops the request", async (t) => {
  const l = await load(t, {
    reply: () => ({ status: 200, body: { data: [{ b64_json: PNG }] } }),
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => l.run("generate_image", { prompt: "x" }, controller.signal),
    /Cancelled/,
  );
});
