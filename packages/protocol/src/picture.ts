/**
 * People's pictures. Onlay keeps its own copy of each person's picture (the
 * sign-in provider's, fetched at sign-in, or one the person uploaded) and
 * serves it from the service origin, so no client ever loads an image from a
 * provider. A person's `avatarUrl` on the wire is one of two service-relative
 * paths, each naming the copy by its key (a new key for new bytes):
 *
 * - `/s/<spaceId>/people/<personId>/picture/<key>`: through that space, which
 *   answers only a caller who may see that person there (missing and not
 *   yours are the same `not_found`);
 * - `/api/me/picture/<key>`: the signed-in person's own.
 *
 * Clients draw nothing else: any other value (an `https:` address an older
 * server sent, say) shows the person's initials.
 */
import { captureImageInfoOf } from "./capture";
import { LIMITS } from "./limits";

/** The image types a stored picture may have (never SVG, never GIF). */
export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type PictureType = (typeof PICTURE_TYPES)[number];

/** 16 base32 characters: what names one stored copy. */
export const PICTURE_KEY_RE = /^[a-z2-7]{16}$/;

const SPACE_PICTURE_RE =
  /^\/s\/(s_[a-z2-7]{20})\/people\/(p_[a-z2-7]{20})\/picture\/([a-z2-7]{16})$/;
const OWN_PICTURE_RE = /^\/api\/me\/picture\/([a-z2-7]{16})$/;

/** The largest picture stored (provider or upload), in bytes. */
export const MAX_PICTURE_BYTES = LIMITS.MAX_PICTURE_BYTES;
/** The largest side a stored picture may have, in pixels. */
export const MAX_PICTURE_SIDE = 1_024;
/** The side the web app resizes an upload to before sending it. */
export const PICTURE_UPLOAD_SIDE = 128;

export function spacePictureUrl(spaceId: string, personId: string, key: string): string {
  return `/s/${spaceId}/people/${personId}/picture/${key}`;
}

export function ownPictureUrl(key: string): string {
  return `/api/me/picture/${key}`;
}

export type PicturePath =
  | { kind: "space"; spaceId: string; personId: string; key: string }
  | { kind: "own"; key: string };

/** A picture path a client may load, or null for anything else. */
export function parsePictureUrl(url: string | undefined): PicturePath | null {
  if (url === undefined || url.length > 128) return null;
  const space = SPACE_PICTURE_RE.exec(url);
  if (space) {
    return {
      kind: "space",
      spaceId: space[1] ?? "",
      personId: space[2] ?? "",
      key: space[3] ?? "",
    };
  }
  const own = OWN_PICTURE_RE.exec(url);
  return own ? { kind: "own", key: own[1] ?? "" } : null;
}

/** True when `url` is a picture path a client may load from its service. */
export function isPictureUrl(url: string | undefined): url is string {
  return parsePictureUrl(url) !== null;
}

/**
 * A picture's type from its own bytes (never from a header or a file name):
 * PNG, JPEG or WebP whose header gives a size of 1 to `MAX_PICTURE_SIDE`
 * pixels a side, within `MAX_PICTURE_BYTES`. Anything else (SVG, GIF, HTML,
 * a truncated or oversized image) is null. The server checks every stored
 * picture with it, and the extension every picture it is handed.
 */
export function pictureTypeOf(bytes: Uint8Array): PictureType | null {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_PICTURE_BYTES) return null;
  const info = captureImageInfoOf(bytes);
  if (!info || !(PICTURE_TYPES as readonly string[]).includes(info.mime)) return null;
  const { width, height } = info;
  if (width === undefined || height === undefined) return null;
  if (width < 1 || height < 1 || width > MAX_PICTURE_SIDE || height > MAX_PICTURE_SIDE) return null;
  return info.mime as PictureType;
}
