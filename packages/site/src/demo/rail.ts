// The page's own guide to the demo: three steps that tick as the visitor does
// each, in the hero's invitation and, once the visitor has started and
// scrolled on, in a small strip at the corner. It never blocks and can be
// ignored. When all three are done it says, once, what the extension does,
// and offers the install button. It is part of the page, not of Onlay: it is
// drawn in the page's own type, and a pick never lands on it.
//
// The first step is a control: it starts a block pick, the pick the product's
// "Comment on block" starts. The other two are marks. And because the
// simulated overlay behaves as the product does (its launcher opens the
// Inbox, and an empty Inbox lists nothing), the guide says, beside the bar,
// where the commands are; during a pick started from the keyboard it says
// which keys steer it.
import { installHref } from "../config";
import { COPY, OWN } from "../copy";
import type { DemoLayer } from "./layer";
import type { Steps } from "./store";

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** The same list the hero carries: a number, or a tick once done; the first step is a control. */
function stepsList(onPick: () => void): { list: HTMLOListElement; paint(steps: Steps): void } {
  const list = h("ol", "steps");
  const rows = COPY.demo.steps.map((label, i) => {
    const li = h("li", "step");
    const mark = h("span", "step-n", String(i + 1));
    mark.setAttribute("aria-hidden", "true");
    const said = h("span", "sr-only");
    if (i === 0) {
      const go = h("button", "step-go");
      go.type = "button";
      go.append(mark, h("span", "step-label", label));
      go.addEventListener("click", onPick);
      li.append(go, said);
    } else {
      li.append(mark, h("span", "step-label", label), said);
    }
    list.appendChild(li);
    return { li, mark, said, n: String(i + 1) };
  });
  return {
    list,
    paint(steps) {
      rows.forEach((row, i) => {
        const done = steps[i] === true;
        row.li.classList.toggle("is-done", done);
        row.mark.textContent = row.n;
        row.said.textContent = done ? " (done)" : "";
      });
    },
  };
}

/** The rail, wired; `destroy` takes it away and puts the hero's steps back as they were. */
export interface Rail {
  destroy(): void;
}

export function wireRail(layer: DemoLayer): Rail {
  const { store } = layer;
  const invite = document.querySelector<HTMLElement>("[data-invite]");
  const heroSteps = [...document.querySelectorAll<HTMLElement>("[data-steps] [data-step]")];
  const heroStartOver = document.querySelector<HTMLButtonElement>("[data-start-over]");
  const heroDone = document.querySelector<HTMLElement>("[data-invite-done]");
  const heroPick = document.querySelector<HTMLButtonElement>("[data-pick-step]");
  const startPick = (): void => layer.startPick();

  const rail = h("aside", "rail");
  rail.setAttribute("data-demo-chrome", "");
  rail.setAttribute("aria-label", OWN.demo.railLabel);
  rail.hidden = true;

  /* the strip: the steps, and a way to begin again */
  const strip = h("div", "rail-strip");
  const mini = stepsList(startPick);
  const again = h("button", "text-btn", OWN.demo.startOver);
  again.type = "button";
  strip.append(mini.list, again);

  /* the closing card */
  const card = h("div", "rail-done");
  card.hidden = true;
  card.setAttribute("role", "status");
  const said = h("p", "rail-done-text", COPY.demo.done);
  const acts = h("div", "rail-done-acts");
  const install = h("a", "cta cta-primary", COPY.install.cta);
  install.href = installHref();
  const again2 = h("button", "text-btn", OWN.demo.startOver);
  again2.type = "button";
  const close = h("button", "rail-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", OWN.demo.dismiss);
  acts.append(install, again2);
  card.append(close, said, acts);
  rail.append(strip, card);
  document.body.appendChild(rail);

  /* the hint: what the page says beside the simulated overlay, above its dimming */
  const hint = h("div", "page-hint");
  hint.setAttribute("data-demo-chrome", "");
  hint.setAttribute("role", "status");
  hint.hidden = true;
  // The sentence names the key; the key is also a control, for a screen without one.
  const hintText = h("p", "page-hint-text");
  const [beforeKey, afterKey] = OWN.demo.emptyInbox.split(OWN.demo.escKey);
  const hintKey = h("button", "key key-go", OWN.demo.escKey);
  hintKey.type = "button";
  hintKey.addEventListener("click", () => layer.escape());
  hintText.append(beforeKey ?? "", hintKey, afterKey ?? "");
  const hintGo = h("button", "step-go");
  hintGo.type = "button";
  hintGo.append(h("span", "step-label", COPY.demo.steps[0]));
  hintGo.addEventListener("click", startPick);
  const hintKeys = h("p", "page-hint-keys micro");
  for (const key of OWN.demo.pickKeys) hintKeys.appendChild(h("span", undefined, key));
  const hintBlock = h("p", "sr-only");
  hint.append(hintText, hintGo, hintKeys, hintBlock);
  // After the overlay's host, so it shows above the bar's dimming.
  document.documentElement.appendChild(hint);

  layer.onSurface((s) => {
    const inbox = s.emptyInbox !== null;
    hint.hidden = !inbox && !s.pickingByKeys;
    hint.classList.toggle("is-inbox", inbox);
    hintText.hidden = !inbox;
    hintGo.hidden = !inbox;
    hintKeys.hidden = inbox || !s.pickingByKeys;
    hintBlock.textContent = s.block ?? "";
    if (s.emptyInbox) {
      // Under the bar, wherever the bar is.
      hint.style.top = `${Math.round(s.emptyInbox.bottom + 14)}px`;
      hint.style.bottom = "auto";
    } else {
      hint.style.top = "";
      hint.style.bottom = "";
    }
  });
  heroPick?.addEventListener("click", startPick);

  let engaged = false;
  let heroInView = true;
  let dismissed = false;
  let wasComplete = false;

  function paint(): void {
    const steps = store.steps();
    const complete = store.complete();
    heroSteps.forEach((li, i) => {
      const done = steps[i] === true;
      li.classList.toggle("is-done", done);
      const sr = li.querySelector(".sr-only");
      if (sr) sr.textContent = done ? " (done)" : "";
    });
    mini.paint(steps);
    const started = steps.some(Boolean) || store.items().length > 0;
    if (heroStartOver) heroStartOver.hidden = !started;
    if (complete && !wasComplete) dismissed = false;
    wasComplete = complete;
    // In the hero the closing words sit with the steps; once the hero is out
    // of view they follow in the corner, where they can be closed.
    if (heroDone) heroDone.hidden = !complete;
    card.hidden = !complete || dismissed || heroInView;
    strip.hidden = complete || heroInView || !engaged;
    rail.hidden = card.hidden && strip.hidden;
    rail.classList.toggle("is-done", !card.hidden);
  }

  const startOver = (): void => {
    dismissed = false;
    layer.startOver();
  };
  again.addEventListener("click", startOver);
  again2.addEventListener("click", startOver);
  heroStartOver?.addEventListener("click", startOver);
  close.addEventListener("click", () => {
    dismissed = true;
    paint();
  });

  const watcher =
    invite && typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          heroInView = entries[entries.length - 1]?.isIntersecting ?? true;
          paint();
        })
      : null;
  if (invite) watcher?.observe(invite);
  layer.onEngaged(() => {
    engaged = true;
    paint();
  });
  const unsubscribe = store.subscribe(paint);
  paint();

  return {
    destroy() {
      unsubscribe();
      watcher?.disconnect();
      heroStartOver?.removeEventListener("click", startOver);
      heroPick?.removeEventListener("click", startPick);
      hint.remove();
      rail.remove();
      for (const li of heroSteps) {
        li.classList.remove("is-done");
        const sr = li.querySelector(".sr-only");
        if (sr) sr.textContent = "";
      }
      if (heroStartOver) heroStartOver.hidden = true;
      if (heroDone) heroDone.hidden = true;
    },
  };
}
