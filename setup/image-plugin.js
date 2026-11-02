// DozalDevs AI Relay: image tools for OpenCode 2.
//
// Installed by the relay's setup command into your OpenCode plugins folder. It adds two tools the
// assistant can use: generate_image and edit_image. They call this relay with the key the setup
// saved on your computer, and save every picture under generated-images/ in your project.
// The key is read from its private file when a tool runs; it is never put in a tool result.
//
// Served by the relay at __RELAY_URL__/setup/image-plugin.js. Run the setup again to update it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RELAY = "__RELAY_URL__";
const OUTPUT_DIR = "generated-images";
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 5;
const TIMEOUT_MS = 240_000;

const dataHome = () =>
  process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const keyFile = () => path.join(dataHome(), "opencode", "dozaldevs-relay.key");

function readKey() {
  const key = fs.existsSync(keyFile()) ? fs.readFileSync(keyFile(), "utf8").trim() : "";
  if (key) return key;
  throw new Error(
    "No relay key found on this computer. Run the relay setup again (the command on your page), then restart OpenCode.",
  );
}

function sniff(buf) {
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.length > 6 && /^GIF8[79]a/.test(buf.subarray(0, 6).toString("latin1"))) return "image/gif";
  return null;
}

function slug(text) {
  const s = String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "image";
}

function insideProject(root, target) {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function callRelay(route, body, signal) {
  const key = readKey();
  let res;
  try {
    res = await fetch(`${RELAY}/v1/images/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(TIMEOUT_MS)]),
    });
  } catch (err) {
    if (signal?.aborted) throw new Error("Cancelled.");
    throw new Error(`Could not reach the relay at ${RELAY}. Check your internet connection and try again.`);
  }
  const text = await res.text();
  const json = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("The relay did not accept your key. Run the relay setup again to refresh it.");
    }
    throw new Error(json?.error?.message || `The relay answered with an error (${res.status}).`);
  }
  if (!json || !Array.isArray(json.data) || json.data.length === 0) {
    throw new Error("The relay answered without a picture.");
  }
  return json;
}

function saveImages(root, json, wantedName, prompt) {
  const dir = path.join(root, OUTPUT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const stem = wantedName ? slug(wantedName.replace(/\.[A-Za-z0-9]+$/, "")) : `${slug(prompt)}-${Date.now().toString(36)}`;
  const saved = [];
  json.data.forEach((item, i) => {
    const bytes = Buffer.from(item.b64_json, "base64");
    const mime = sniff(bytes) ?? "image/png";
    const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png";
    const base = json.data.length > 1 ? `${stem}-${i + 1}` : stem;
    for (let n = 0; n < 1000; n++) {
      const file = path.join(dir, n === 0 ? `${base}.${ext}` : `${base}-${n}.${ext}`);
      try {
        fs.writeFileSync(file, bytes, { flag: "wx" });
        saved.push({ file, bytes, mime, revised: item.revised_prompt });
        return;
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
      }
    }
    throw new Error("Could not find a free file name in generated-images/.");
  });
  return saved;
}

function result(root, json, saved, extra) {
  const lines = saved.map((s) => `Saved ${path.relative(root, s.file)} (${Math.round(s.bytes.length / 1024)} KB)`);
  const revised = saved.find((s) => s.revised)?.revised;
  if (revised) lines.push(`The image service rewrote the prompt as: ${revised}`);
  if (json.warning) lines.push(json.warning);
  if (extra) lines.push(extra);
  return {
    content: [
      { type: "text", text: lines.join("\n") },
      ...saved.map((s) => ({
        type: "file",
        mime: s.mime,
        uri: `data:${s.mime};base64,${s.bytes.toString("base64")}`,
        name: path.basename(s.file),
      })),
    ],
  };
}

const optionProps = {
  size: { type: "string", description: 'Optional. "auto" or a size like "1024x1024" or "1536x1024". The service treats it as a hint.' },
  quality: { type: "string", enum: ["low", "medium", "high"], description: "Optional. low is fastest and cheapest; use medium or high for text in the picture or fine detail." },
  background: { type: "string", enum: ["auto", "opaque", "transparent"], description: "Optional. transparent gives a cut-out picture (stickers, logos)." },
  model: { type: "string", description: "Optional. Leave this out unless the person names an image model." },
  filename: { type: "string", description: "Optional. A short file name without a folder, like login-hero." },
};

export default {
  id: "dozaldevs.images",
  setup(ctx) {
    const root = ctx.location.directory;
    const optionsFrom = (input) => {
      const o = {};
      for (const k of ["size", "quality", "background", "model"]) if (typeof input[k] === "string" && input[k]) o[k] = input[k];
      return o;
    };
    ctx.tool.transform((editor) => {
      editor.add({
        name: "generate_image",
        description:
          "Create a new image from a text description using the team's image service, and save it in the project's generated-images folder. Use it when the person asks you to draw, design, illustrate or generate a picture. Write a detailed prompt: subject, style, colors, composition, and any exact words that must appear in the picture. It can take up to a minute.",
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "A detailed description of the image." },
            n: { type: "integer", minimum: 1, maximum: 4, description: "Optional. How many variations (default 1)." },
            ...optionProps,
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const json = await callRelay("generations", { prompt: input.prompt, ...(input.n ? { n: input.n } : {}), ...optionsFrom(input) }, context?.signal);
          return result(root, json, saveImages(root, json, input.filename, input.prompt));
        },
      });

      editor.add({
        name: "edit_image",
        description:
          "Change an existing picture, or make a new one guided by pictures you already have, using the team's image service. Give the file paths of 1 to 5 images inside the project (png, jpeg, webp or gif) and describe the result you want. The original files are never changed; the result is saved as a new file in generated-images.",
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "What the result should look like, or what to change." },
            image_paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_IMAGES, description: "Paths of the images to use, relative to the project folder." },
            ...optionProps,
          },
          required: ["prompt", "image_paths"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const paths = Array.isArray(input.image_paths) ? input.image_paths : [];
          if (paths.length < 1 || paths.length > MAX_IMAGES) throw new Error(`Give 1 to ${MAX_IMAGES} image paths.`);
          const realRoot = fs.realpathSync(root);
          const files = paths.map((p) => {
            const abs = path.resolve(root, String(p));
            let real;
            try {
              real = fs.realpathSync(abs);
            } catch {
              throw new Error(`There is no file at ${p}.`);
            }
            if (!insideProject(realRoot, real)) throw new Error(`${p} is outside the project folder. Copy it into the project first.`);
            return { given: String(p), real };
          });
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "edit_image",
            resources: files.map((f) => path.relative(realRoot, f.real)),
            save: files.map((f) => path.relative(realRoot, f.real)),
          });
          const images = files.map((f) => {
            const stat = fs.statSync(f.real);
            if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error(`${f.given} is not a picture file of 20 MB or less.`);
            const bytes = fs.readFileSync(f.real);
            const mime = sniff(bytes);
            if (!mime) throw new Error(`${f.given} is not a png, jpeg, webp or gif picture.`);
            return `data:${mime};base64,${bytes.toString("base64")}`;
          });
          const json = await callRelay("edits", { prompt: input.prompt, images, ...optionsFrom(input) }, context?.signal);
          return result(root, json, saveImages(root, json, input.filename, input.prompt));
        },
      });
    });
  },
};
