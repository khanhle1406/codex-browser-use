import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import {
  REPO_GLOW_ACTIVE,
  evaluateCursorDirective,
  resetDirectorDefaults,
  setRoamingEnabled,
} from "../lib/cursorDirector";
import {
  computeBankRotation,
  computeSpeedStretch,
  computeThinkingWobble,
  createSpring,
  snapSpring,
  stepAngleSpring,
  stepSpring,
  type Point,
} from "../lib/cursorPhysics";

const ROAM_MQ = "(prefers-reduced-motion: no-preference) and (min-width: 960px)";
const TRAIL_MAX_POINTS = 10;

// Exact SVG path (`xt`) extracted verbatim from mcp-server/extension/content-script.js
const REPO_CURSOR_PATH =
  "M3.04536 4.45259C2.7582 3.60299 3.60299 2.7582 4.45259 3.04536L14.1828 6.33403C15.1637 6.66558 15.0872 8.08006 14.0715 8.39045L10.2994 9.54319C9.93919 9.65327 9.65327 9.93919 9.54319 10.2994L8.39046 14.0715C8.08007 15.1637 6.66558 15.1637 6.33404 14.1828L3.04536 4.45259Z";

export function RoamingRepoCursor() {
  const anchorRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const trailRef = useRef<SVGPathElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const rippleRef = useRef<HTMLDivElement>(null);
  const rippleOuterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mq = window.matchMedia(ROAM_MQ);
    const docEl = document.documentElement;

    let cleanupLoop: (() => void) | null = null;

    const startEngine = () => {
      docEl.classList.add("has-roaming-cursor");
      setRoamingEnabled(true);

      const springX = createSpring(window.innerWidth * 0.62, 0.9, 0.14);
      const springY = createSpring(Math.min(window.innerHeight * 0.5, 440), 0.9, 0.14);
      const springRot = createSpring(-44, 0.88, 0.12);
      const springStretch = createSpring(1, 0.85, 0.16);
      const springVis = createSpring(1, 0.9, 0.28);

      let initialized = false;
      let lastTimeMs = performance.now();
      const engineStartMs = performance.now();
      let queuedClickKey: string | null = null;
      let pendingClick: { key: string; glow: string; targetId: string | null; queuedAt: number } | null = null;
      let lastPillText = "";
      let lastGlowColor = REPO_GLOW_ACTIVE;
      const trailPoints: Point[] = [];

      const cancelAnimations = (el: HTMLElement | null) => {
        if (!el || typeof el.getAnimations !== "function") return;
        for (const anim of el.getAnimations()) anim.cancel();
      };

      const triggerClickBurst = (pt: Point, glow: string, targetId: string | null) => {
        const tx = `translate3d(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px, 0)`;

        if (pressRef.current) {
          cancelAnimations(pressRef.current);
          pressRef.current.animate(
            [
              { transform: "translate3d(0, 0, 0) scale(1)" },
              { transform: "translate3d(0, 3px, 0) scale(0.74)", offset: 0.26 },
              { transform: "translate3d(0, -0.5px, 0) scale(1.05)", offset: 0.68 },
              { transform: "translate3d(0, 0, 0) scale(1)" },
            ],
            { duration: 340, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
          );
        }

        if (flashRef.current) {
          const flash = flashRef.current;
          cancelAnimations(flash);
          flash.style.setProperty("--cbu-glow", glow);
          flash.style.transform = "";
          flash.animate(
            [
              { opacity: 1, transform: `${tx} scale(0.25)` },
              { opacity: 0.92, transform: `${tx} scale(1.35)`, offset: 0.36 },
              { opacity: 0, transform: `${tx} scale(1.75)` },
            ],
            { duration: 360, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
          );
        }

        const ripple = rippleRef.current;
        if (ripple) {
          cancelAnimations(ripple);
          ripple.style.setProperty("--cbu-glow", glow);
          ripple.style.transform = "";
          ripple.animate(
            [
              { opacity: 0.98, transform: `${tx} scale(0.22)` },
              { opacity: 0, transform: `${tx} scale(2.15)` },
            ],
            { duration: 580, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
          );
        }

        const outer = rippleOuterRef.current;
        if (outer) {
          cancelAnimations(outer);
          outer.style.setProperty("--cbu-glow", glow);
          outer.style.transform = "";
          outer.animate(
            [
              { opacity: 0, transform: `${tx} scale(0.3)` },
              { opacity: 0.78, transform: `${tx} scale(0.55)`, offset: 0.12 },
              { opacity: 0, transform: `${tx} scale(2.85)` },
            ],
            { duration: 680, delay: 75, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
          );
        }

        if (targetId) {
          const targetEl = document.querySelector<HTMLElement>(`[data-cursor-target="${targetId}"]`);
          if (targetEl) {
            cancelAnimations(targetEl);
            targetEl.animate(
              [
                { transform: "scale(1)" },
                { transform: "scale(0.965)", offset: 0.35 },
                { transform: "scale(1)" },
              ],
              { duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
            );
          }
        }
      };

      const onTick = () => {
        const now = performance.now();
        const dt = Math.min(0.05, Math.max(0.004, (now - lastTimeMs) / 1000));
        lastTimeMs = now;
        const clockSec = (now - engineStartMs) / 1000;

        const directive = evaluateCursorDirective(clockSec);
        if (directive.targetPoint) {
          if (!initialized) {
            snapSpring(springX, directive.targetPoint.x);
            snapSpring(springY, directive.targetPoint.y);
            initialized = true;
          } else {
            springX.target = directive.targetPoint.x;
            springY.target = directive.targetPoint.y;
          }
        }

        springVis.target = directive.visible ? 1 : 0;

        const prevX = springX.value;
        const prevY = springY.value;
        const targetDist = Math.hypot(springX.target - springX.value, springY.target - springY.value);
        const targetResponse = targetDist > 180 ? 0.16 : 0.105;
        springX.response = targetResponse;
        springY.response = targetResponse;
        stepSpring(springX, dt);
        stepSpring(springY, dt);
        stepSpring(springVis, dt);

        const vx = (springX.value - prevX) / dt;
        const vy = (springY.value - prevY) / dt;
        const speed = Math.hypot(vx, vy);

        let targetRot = computeBankRotation(vx, vy, speed);
        if (directive.wobble && speed < 40) {
          targetRot += computeThinkingWobble(clockSec);
        }
        stepAngleSpring(springRot, targetRot, dt);

        springStretch.target = computeSpeedStretch(speed);
        stepSpring(springStretch, dt);

        const anchor = anchorRef.current;
        const pointer = pointerRef.current;
        if (anchor && pointer) {
          const vis = springVis.value;
          const s = 0.4 + 0.6 * vis;
          const blurPx = ((1 - vis) * 5).toFixed(2);
          anchor.style.transform = `translate3d(${springX.value.toFixed(2)}px, ${springY.value.toFixed(
            2
          )}px, 0) scale(${s.toFixed(3)})`;
          anchor.style.opacity = vis.toFixed(3);
          anchor.style.filter = vis < 0.99 ? `blur(${blurPx}px)` : "none";

          pointer.style.transform = `rotate(${springRot.value.toFixed(2)}deg) scaleX(${springStretch.value.toFixed(
            3
          )})`;

          if (directive.glowColor !== lastGlowColor) {
            lastGlowColor = directive.glowColor;
            anchor.style.setProperty("--cbu-glow", directive.glowColor);
          }
        }

        const pill = pillRef.current;
        if (pill && directive.pillText !== lastPillText) {
          lastPillText = directive.pillText;
          pill.textContent = directive.pillText;
          pill.style.opacity = directive.pillText ? "1" : "0";
          if (directive.pillText) {
            cancelAnimations(pill);
            pill.animate(
              [
                { transform: "translate3d(18px, 16px, 0) scale(0.92)" },
                { transform: "translate3d(18px, 16px, 0) scale(1.04)", offset: 0.45 },
                { transform: "translate3d(18px, 16px, 0) scale(1)" },
              ],
              { duration: 230, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
            );
          }
        }

        const trail = trailRef.current;
        if (trail) {
          trailPoints.push({ x: springX.value, y: springY.value });
          if (trailPoints.length > TRAIL_MAX_POINTS) {
            trailPoints.shift();
          }

          if (trailPoints.length >= 2 && speed > 140 && springVis.value > 0.2) {
            const d = trailPoints
              .map((p, idx) => `${idx === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
              .join(" ");
            trail.setAttribute("d", d);
            trail.style.stroke = lastGlowColor;
            trail.style.opacity = Math.min(0.52, (speed - 140) / 950).toFixed(3);
          } else {
            trail.style.opacity = "0";
          }
        }

        if (!directive.visible) {
          queuedClickKey = null;
          pendingClick = null;
        } else if (directive.clickKey && directive.clickKey !== queuedClickKey) {
          queuedClickKey = directive.clickKey;
          pendingClick = {
            key: directive.clickKey,
            glow: directive.glowColor,
            targetId: directive.clickTargetId ?? null,
            queuedAt: now,
          };
        } else if (!directive.clickKey) {
          queuedClickKey = null;
          pendingClick = null;
        }

        if (pendingClick && springVis.value > 0.45) {
          const distToTarget = directive.targetPoint
            ? Math.hypot(directive.targetPoint.x - springX.value, directive.targetPoint.y - springY.value)
            : 0;
          if (distToTarget <= 16 || (distToTarget <= 90 && now - pendingClick.queuedAt >= 260)) {
            triggerClickBurst(
              { x: springX.value, y: springY.value },
              pendingClick.glow,
              pendingClick.targetId
            );
            pendingClick = null;
          }
        }
      };

      gsap.ticker.add(onTick);
      onTick();

      return () => {
        gsap.ticker.remove(onTick);
        docEl.classList.remove("has-roaming-cursor");
        setRoamingEnabled(false);
      };
    };

    const stopEngine = () => {
      if (cleanupLoop) {
        cleanupLoop();
        cleanupLoop = null;
      }
      docEl.classList.remove("has-roaming-cursor");
      setRoamingEnabled(false);
      resetDirectorDefaults();
    };

    const sync = () => {
      if (mq.matches) {
        if (!cleanupLoop) cleanupLoop = startEngine();
      } else {
        stopEngine();
      }
    };

    sync();
    mq.addEventListener("change", sync);

    return () => {
      mq.removeEventListener("change", sync);
      stopEngine();
    };
  }, []);

  return (
    <div className="roaming-cursor-layer" aria-hidden="true">
      <svg className="roaming-comet-svg">
        <path ref={trailRef} className="roaming-comet-path" fill="none" />
      </svg>

      <div ref={flashRef} className="roaming-cursor-flash" />
      <div ref={rippleRef} className="roaming-cursor-ripple" />
      <div ref={rippleOuterRef} className="roaming-cursor-ripple roaming-cursor-ripple--outer" />

      <div ref={anchorRef} className="roaming-cursor-anchor">
        <div ref={pointerRef} className="roaming-cursor-pointer">
          <div ref={pressRef} className="roaming-cursor-press-wrap">
            <svg viewBox="0 0 23 24" width="23" height="24" className="roaming-cursor-svg">
              <path
                d={REPO_CURSOR_PATH}
                fill="#000000"
                stroke="#ffffff"
                strokeWidth="3.2"
                strokeLinejoin="round"
                paintOrder="stroke fill"
                transform="translate(0.86 0.86) scale(1.22)"
              />
            </svg>
          </div>
        </div>

        <span ref={pillRef} className="roaming-cursor-pill">
          Scroll to watch
        </span>
      </div>
    </div>
  );
}
