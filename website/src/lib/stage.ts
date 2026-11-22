import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

let activeLenis: Lenis | null = null;

export function scrollToY(y: number, duration = 1.1): void {
  if (activeLenis) {
    activeLenis.scrollTo(y, { duration });
    return;
  }
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: y, behavior: reduce ? "auto" : "smooth" });
}

export function initSmoothStage(): () => void {
  const docEl = document.documentElement;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const enterTargets = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-enter]:not([data-entered])"));

  let io: IntersectionObserver | null = null;
  let mo: MutationObserver | null = null;

  if (reduceMotion || !("IntersectionObserver" in window)) {
    enterTargets().forEach((el) => el.setAttribute("data-entered", ""));
  } else {
    io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.setAttribute("data-entered", "");
            io?.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.01 }
    );

    const observeAll = () => {
      enterTargets().forEach((el) => io?.observe(el));
    };

    observeAll();
    docEl.classList.add("enter-ready");

    mo = new MutationObserver(observeAll);
    mo.observe(document.body, { childList: true, subtree: true });
  }

  let rafCallback: ((time: number) => void) | null = null;
  let onAnchorClick: ((event: MouseEvent) => void) | null = null;

  if (!reduceMotion) {
    const lenis = new Lenis({
      duration: 1.15,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
    });
    activeLenis = lenis;
    docEl.classList.add("is-smooth");

    lenis.on("scroll", ScrollTrigger.update);
    rafCallback = (time: number) => {
      lenis.raf(time * 1000);
    };
    gsap.ticker.add(rafCallback);
    gsap.ticker.lagSmoothing(0);

    onAnchorClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const anchor = target?.closest<HTMLAnchorElement>('a[href^="#"]');
      if (!anchor) return;
      const rawHash = anchor.getAttribute("href") ?? "";
      if (rawHash.length <= 1) return;
      const dest = document.getElementById(rawHash.slice(1));
      if (!dest) return;
      event.preventDefault();
      if (history.pushState) history.pushState(null, "", rawHash);
      lenis.scrollTo(dest, { duration: 1.1 });
    };
    document.addEventListener("click", onAnchorClick);
  }

  return () => {
    io?.disconnect();
    mo?.disconnect();
    docEl.classList.remove("enter-ready", "is-smooth");
    if (onAnchorClick) document.removeEventListener("click", onAnchorClick);
    if (rafCallback) gsap.ticker.remove(rafCallback);
    if (activeLenis) {
      activeLenis.destroy();
      activeLenis = null;
    }
  };
}
