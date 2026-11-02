import { KeyStoreError } from "../keys/store";

export const MAX_IMAGES_PER_REQUEST = 4;
export const MAX_INPUT_IMAGES = 5;
export const MAX_PROMPT_LENGTH = 32_000;
/** Base64 text, so roughly 20 MB of picture. */
export const MAX_INPUT_IMAGE_CHARS = 28_000_000;

const SIZE_RE = /^(auto|\d{3,4}x\d{3,4})$/;
const QUALITIES = ["auto", "low", "medium", "high", "xhigh", "max"];
const BACKGROUNDS = ["auto", "opaque", "transparent"];
const MODERATION = ["auto", "low"];
const OUTPUT_FORMATS = ["png", "jpeg", "webp"];
const DATA_URL_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export interface ImageOptions {
  size?: string;
  quality?: string;
  background?: string;
  moderation?: string;
  output_format?: string;
}

export interface ImageRequest {
  kind: "generate" | "edit";
  model?: string;
  prompt: string;
  n: number;
  images: string[];
  options: ImageOptions;
}

function bad(message: string): never {
  throw new KeyStoreError(400, message);
}

function oneOf(
  body: Record<string, unknown>,
  field: string,
  allowed: string[],
): string | undefined {
  const v = body[field];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !allowed.includes(v)) {
    bad(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return v;
}

/** Turns the caller's body into one checked request. Everything that is not understood is refused, never guessed. */
export function parseImageRequest(
  kind: "generate" | "edit",
  body: unknown,
): ImageRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    bad("send a JSON body with at least a prompt");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.prompt !== "string" || !b.prompt.trim()) {
    bad("prompt is required: describe the image you want");
  }
  if (b.prompt.length > MAX_PROMPT_LENGTH) {
    bad(`prompt must be at most ${MAX_PROMPT_LENGTH} characters`);
  }
  let n = 1;
  if (b.n !== undefined && b.n !== null) {
    if (
      typeof b.n !== "number" ||
      !Number.isInteger(b.n) ||
      b.n < 1 ||
      b.n > MAX_IMAGES_PER_REQUEST
    ) {
      bad(`n must be a whole number from 1 to ${MAX_IMAGES_PER_REQUEST}`);
    }
    n = b.n;
  }
  if (
    b.response_format !== undefined &&
    b.response_format !== null &&
    b.response_format !== "b64_json"
  ) {
    bad(
      'this relay returns images as base64 in "b64_json"; leave response_format out or use "b64_json"',
    );
  }
  if (b.mask !== undefined && b.mask !== null) {
    bad("masks are not supported; describe the part to change in the prompt");
  }
  const size = b.size;
  if (size !== undefined && size !== null && size !== "") {
    if (typeof size !== "string" || !SIZE_RE.test(size)) {
      bad('size must be "auto" or like "1024x1024"');
    }
  }
  const options: ImageOptions = {};
  if (typeof size === "string" && size) options.size = size;
  const quality = oneOf(b, "quality", QUALITIES);
  if (quality) options.quality = quality;
  const background = oneOf(b, "background", BACKGROUNDS);
  if (background) options.background = background;
  const moderation = oneOf(b, "moderation", MODERATION);
  if (moderation) options.moderation = moderation;
  const outputFormat = oneOf(b, "output_format", OUTPUT_FORMATS);
  if (outputFormat) options.output_format = outputFormat;

  const images: string[] = [];
  if (kind === "edit") {
    const raw: unknown[] = Array.isArray(b.images)
      ? b.images
      : b.image !== undefined
        ? [b.image]
        : b.image_url !== undefined
          ? [b.image_url]
          : [];
    for (const item of raw) {
      const url =
        typeof item === "string"
          ? item
          : item && typeof item === "object"
            ? (item as Record<string, unknown>).image_url
            : undefined;
      if (typeof url !== "string" || !DATA_URL_RE.test(url)) {
        bad(
          'each image must be a data URL like "data:image/png;base64,...", as a string or {"image_url": "..."}',
        );
      }
      if (url.length > MAX_INPUT_IMAGE_CHARS)
        bad("an input image is too large");
      images.push(url);
    }
    if (images.length < 1 || images.length > MAX_INPUT_IMAGES) {
      bad(`send 1 to ${MAX_INPUT_IMAGES} images to edit`);
    }
  } else if (b.images !== undefined || b.image !== undefined) {
    bad("this route only makes new images; use /v1/images/edits to change one");
  }

  const model =
    typeof b.model === "string" && b.model.trim() ? b.model.trim() : undefined;
  return { kind, model, prompt: b.prompt.trim(), n, images, options };
}
