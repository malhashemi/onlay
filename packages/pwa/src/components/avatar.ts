// A person's avatar: a round face with their initials on their tint, or their
// picture when they have one (a failed load falls back to initials). The
// picture is always Onlay's own copy, a path on this service that a space (or
// /api/me, for oneself) answers to this browser alone: never a provider's
// address, which the web app's CSP refuses and which would tell the provider
// where people look. The face is named for assistive technology by the
// person's name. The tint is per-person data assigned at first sign-in (raw
// hex on the wire is correct here — person tints are data, not brand tokens).
// Agents have no faces of their own: an agent-written message wears its
// person's avatar and an "agent" tag beside the name.
import { isPictureUrl } from "@onlay/protocol";
import { initialsOf } from "@onlay/render/interaction-view";
import { el } from "../dom";

/** What an avatar needs to know about someone. */
export interface Face {
  name: string;
  initials: string;
  tint: string;
  avatarUrl?: string | undefined;
}

function initialsNode(node: HTMLElement, face: Face): void {
  node.textContent = face.initials || initialsOf(face.name);
}

/** The picture an avatar may load, or undefined for initials (anything not Onlay's own path). */
export function pictureOf(face: Face): string | undefined {
  return isPictureUrl(face.avatarUrl) ? face.avatarUrl : undefined;
}

export function avatar(face: Face, size: "sm" | "md" = "sm"): HTMLElement {
  const node = el("span", `avatar round ${size}`);
  node.style.background = face.tint;
  node.title = face.name;
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", face.name);
  const url = pictureOf(face);
  if (url) {
    const img = el("img", "avatar-img") as HTMLImageElement;
    img.alt = "";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => {
      img.remove();
      initialsNode(node, face);
    });
    img.src = url;
    node.append(img);
  } else {
    initialsNode(node, face);
  }
  return node;
}
