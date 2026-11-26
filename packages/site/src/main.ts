// The page's first script, and a small one: the page is already complete as
// markup. It makes the film play on request, asks whether the visitor's own
// Onlay is here, and then, once the page has loaded and the browser is idle,
// brings in everything else (the section fragments' behavior and the demo
// layer) as a separate chunk.
import { EXTENSION_IDS } from "./config";
import { watchDemo } from "./ext";

const root = document.documentElement;
root.classList.add("js");

/* ── the film: it has sound, so it plays only when asked ── */
const film = document.querySelector<HTMLVideoElement>("[data-film]");
const frame = document.querySelector<HTMLElement>("[data-film-frame]");
if (film && frame) {
  // The poster is below the fold: it is fetched when the film comes near, or is asked for.
  const showPoster = (): void => {
    const src = film.dataset.poster;
    if (src && !film.getAttribute("poster")) film.poster = src;
  };
  if (typeof IntersectionObserver === "function") {
    const near = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        showPoster();
        near.disconnect();
      },
      { rootMargin: "100px 0px" },
    );
    near.observe(frame);
  } else {
    showPoster();
  }
  const play = (): void => {
    showPoster();
    frame.classList.add("is-playing");
    void film.play().catch(() => {
      /* the browser's own controls are still there */
    });
  };
  film.addEventListener("play", () => frame.classList.add("is-playing"));
  document.querySelector("[data-film-play]")?.addEventListener("click", () => {
    play();
    film.focus({ preventScroll: true });
  });
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-play-film]")) {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      frame.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
      play();
      film.focus({ preventScroll: true });
    });
  }
}

/* ── everything else, after the page is usable ── */
const idle = new Promise<void>((resolve) => {
  const go = (): void => {
    const ric = (window as { requestIdleCallback?: (fn: () => void, o?: object) => void })
      .requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 1200 });
    else setTimeout(resolve, 200);
  };
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
});

const watch = watchDemo(EXTENSION_IDS);
void Promise.all([watch.mode, idle]).then(async () => {
  try {
    const live = await import("./live");
    // The extension may have answered while the page was loading.
    const demo = live.start(watch.current());
    // And it may answer later still: then the simulation stands down, completely.
    void watch.late.then(() => demo.standDown());
  } catch {
    // The page stands without it: the markup is whole.
  }
});
