// Drawing a person's picture into an avatar, in the overlay and in the
// extension's own pages. The bytes come from the service worker
// (sw/pictures.ts) and are drawn on a canvas: no image request leaves the
// page, so a page's Content-Security-Policy (img-src) never decides whether a
// face shows, and the page learns nothing. The initials stay until the
// picture is drawn, and stay for good when there is none or it can't be read.
//
// Each picture is decoded once into a small shared square (`SHARED_SIDE`
// pixels, its centre cropped), kept within a byte budget; each face's canvas
// is only as large as the face is drawn (times the device pixel ratio).
//
// Every face asks the service worker, in every extension document (the
// overlay, the popup, the options page, the full view): it alone says whether
// the picture may show now (the account, the person's access to its space,
// the space still theirs) and under which scope (the account's generation and
// the space's access revision). A decoded picture is reused only under the
// scope it was decoded in; a refusal drops it. So no document holds a face
// past a change it was never told of. `forgetPictures` (the overlay, on an
// account or access change) also drops every decoded picture at once, and a
// face whose picture was decoded before it is not painted.
import { isPictureUrl } from "@onlay/protocol";

type Ask = (msg: { type: "picture"; url: string; held?: string }) => Promise<unknown>;

const ask: Ask = (msg) => chrome.runtime.sendMessage(msg);

/** The side of the one decoded copy of each picture (a face is at most 48 CSS px). */
export const SHARED_SIDE = 96;
/** Decoded pictures may hold this many bytes in all (about 220 pictures). */
export const DECODED_BUDGET_BYTES = 8 * 1024 * 1024;
/** A face whose size can't be measured yet is drawn for this many CSS px. */
const DEFAULT_FACE_PX = 24;

interface Decoded {
  /** The service worker's scope it was decoded under. */
  scope: string;
  bitmap: Promise<ImageBitmap | null>;
  bytes: number;
}

/** Decoded pictures, by their path (one scope each), least recently used first. */
const decoded = new Map<string, Decoded>();
let decodedBytes = 0;
/** Moves on each `forgetPictures`: a decode from before it is never painted. */
let epoch = 0;

function base64Bytes(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** What the service worker answered: refused, the bytes under a scope, or "the one you hold". */
type Answer =
  | { ok: false }
  | { ok: true; scope: string; held: true }
  | { ok: true; scope: string; type: string; b64: string };

const MAX_SCOPE_CHARS = 256;

async function askFor(url: string, held: string | undefined, send: Ask): Promise<Answer> {
  let answer: unknown;
  try {
    answer = await send(
      held === undefined ? { type: "picture", url } : { type: "picture", url, held },
    );
  } catch {
    return { ok: false };
  }
  const a = answer as
    | { ok?: unknown; scope?: unknown; held?: unknown; type?: unknown; b64?: unknown }
    | undefined;
  if (a?.ok !== true || typeof a.scope !== "string") return { ok: false };
  if (a.scope.length === 0 || a.scope.length > MAX_SCOPE_CHARS) return { ok: false };
  if (a.held === true) return { ok: true, scope: a.scope, held: true };
  if (typeof a.type !== "string" || !TYPES.has(a.type) || typeof a.b64 !== "string")
    return { ok: false };
  return { ok: true, scope: a.scope, type: a.type, b64: a.b64 };
}

async function decode(type: string, b64: string): Promise<ImageBitmap | null> {
  const bytes = base64Bytes(b64);
  if (bytes === null) return null;
  let full: ImageBitmap | null = null;
  try {
    full = await createImageBitmap(new Blob([bytes], { type }));
    // The centre square, resized once to the shared side; the full decode goes at once.
    const side = Math.min(full.width, full.height);
    if (side < 1) return null;
    return await createImageBitmap(
      full,
      Math.floor((full.width - side) / 2),
      Math.floor((full.height - side) / 2),
      side,
      side,
      { resizeWidth: SHARED_SIDE, resizeHeight: SHARED_SIDE, resizeQuality: "high" },
    );
  } catch {
    return null;
  } finally {
    full?.close();
  }
}

function drop(url: string): void {
  const held = decoded.get(url);
  if (!held) return;
  decoded.delete(url);
  decodedBytes -= held.bytes;
  void held.bitmap.then((b) => b?.close());
}

/**
 * The decoded picture at `url` (one of Onlay's picture paths), or null. The
 * service worker is asked every time; what was decoded is reused only under
 * the scope it answers with now.
 */
export async function pictureBitmap(url: string, send: Ask = ask): Promise<ImageBitmap | null> {
  let a = await askFor(url, decoded.get(url)?.scope, send);
  // "The one you hold", but it went meanwhile or is of another scope: once more, for the bytes.
  if (a.ok && "held" in a && decoded.get(url)?.scope !== a.scope)
    a = await askFor(url, undefined, send);
  if (!a.ok) {
    // Refused now: whatever was decoded before goes too.
    drop(url);
    return null;
  }
  const cur = decoded.get(url);
  if (cur && cur.scope === a.scope) {
    // Most recently used last.
    decoded.delete(url);
    decoded.set(url, cur);
    return cur.bitmap;
  }
  if ("held" in a) return null;
  // Another scope's decode is never reused.
  drop(url);
  const bitmap = decode(a.type, a.b64);
  const entry: Decoded = { scope: a.scope, bitmap, bytes: SHARED_SIDE * SHARED_SIDE * 4 };
  decoded.set(url, entry);
  decodedBytes += entry.bytes;
  // A failure is forgotten, so a later face asks again.
  void bitmap.then((b) => {
    if (b === null && decoded.get(url) === entry) drop(url);
  });
  while (decodedBytes > DECODED_BUDGET_BYTES) {
    const oldest = decoded.keys().next().value;
    if (oldest === undefined || oldest === url) break;
    drop(oldest);
  }
  return bitmap;
}

/** Forget every decoded picture (an account or access change). */
export function forgetPictures(): void {
  epoch += 1;
  for (const url of [...decoded.keys()]) drop(url);
}

/** How many bytes decoded pictures hold now (tests). */
export function decodedPictureBytes(): number {
  return decodedBytes;
}

/**
 * Puts the person's picture in `node` (an avatar showing initials) once it is
 * decoded: a canvas filling the face, class `avatar-img`, sized to the face.
 * Nothing happens for a value that is not one of Onlay's picture paths, a
 * picture that can't be read, or one decoded before `forgetPictures`: the
 * initials stay.
 */
export function paintPicture(
  node: HTMLElement,
  url: string | undefined,
  doc: Document = node.ownerDocument,
  send: Ask = ask,
): void {
  if (!isPictureUrl(url)) return;
  const asked = epoch;
  void pictureBitmap(url, send).then((bitmap) => {
    if (bitmap === null || asked !== epoch) return;
    const view = doc.defaultView;
    const css = node.clientWidth > 0 ? node.clientWidth : DEFAULT_FACE_PX;
    const side = Math.max(1, Math.min(SHARED_SIDE, Math.ceil(css * (view?.devicePixelRatio || 1))));
    const canvas = doc.createElement("canvas");
    canvas.className = "avatar-img";
    canvas.width = side;
    canvas.height = side;
    canvas.setAttribute("aria-hidden", "true");
    const g = canvas.getContext("2d");
    if (!g) return;
    g.imageSmoothingQuality = "high";
    try {
      g.drawImage(bitmap, 0, 0, side, side);
    } catch {
      // Closed meanwhile (dropped by a refusal or another scope): the initials stay.
      return;
    }
    node.textContent = "";
    node.append(canvas);
    node.classList.add("has-picture");
  });
}
