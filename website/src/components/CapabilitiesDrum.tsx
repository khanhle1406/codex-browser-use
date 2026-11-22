import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Compass } from "@phosphor-icons/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { CAPABILITIES_DRUM } from "../data/product";

gsap.registerPlugin(ScrollTrigger);

const DRUM_MQ = "(prefers-reduced-motion: no-preference) and (min-width: 768px)";

interface CapabilitiesDrumProps {
  onTuckChange?: (tucked: boolean) => void;
}

export function CapabilitiesDrum({ onTuckChange }: CapabilitiesDrumProps) {
  const rootRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLLIElement | null>>([]);
  const ruleTopRef = useRef<HTMLSpanElement>(null);
  const ruleBottomRef = useRef<HTMLSpanElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const leftPtrRef = useRef<HTMLSpanElement>(null);
  const rightPtrRef = useRef<HTMLSpanElement>(null);

  const [activeIndex, setActiveIndex] = useState(0);
  const [drumEnabled, setDrumEnabled] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(DRUM_MQ).matches : false
  );

  useEffect(() => {
    const mq = window.matchMedia(DRUM_MQ);
    const sync = () => setDrumEnabled(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!drumEnabled || !trackRef.current) {
      onTuckChange?.(false);
      return undefined;
    }

    const ctx = gsap.context(() => {
      const track = trackRef.current;
      if (!track) return;

      const total = CAPABILITIES_DRUM.length;
      const stepAngle = 21;
      const radius = 215;

      const updateWheel = (progress: number) => {
        const cursor = progress * (total - 1);
        const nearest = Math.min(total - 1, Math.max(0, Math.round(cursor)));
        setActiveIndex((prev) => (prev === nearest ? prev : nearest));

        const detent = 1 - Math.min(1, Math.abs(cursor - nearest) * 2.4);
        const nudge = ((1 - detent) * 9).toFixed(1);
        if (leftPtrRef.current && rightPtrRef.current) {
          leftPtrRef.current.style.transform = `translate3d(-${nudge}px, 0, 0)`;
          rightPtrRef.current.style.transform = `translate3d(${nudge}px, 0, 0)`;
        }
        if (glowRef.current) {
          const glowScaleY = (0.82 + 0.18 * detent).toFixed(3);
          glowRef.current.style.opacity = (0.55 + 0.45 * detent).toFixed(3);
          glowRef.current.style.transform = `scale(1, ${glowScaleY})`;
        }

        itemRefs.current.forEach((el, idx) => {
          if (!el) return;
          const offset = idx - cursor;
          const angle = offset * stepAngle;
          const rad = (angle * Math.PI) / 180;
          const y = Math.sin(rad) * radius;
          const z = (Math.cos(rad) - 1) * 140;
          const dist = Math.abs(offset);
          const opacity = Math.max(0, 1 - dist * 0.28);
          const scale = Math.max(0.74, 1 - dist * 0.055);
          el.style.transform = `translate3d(0, ${y.toFixed(1)}px, ${z.toFixed(1)}px) rotateX(${(-angle).toFixed(1)}deg) scale(${scale.toFixed(3)})`;
          el.style.opacity = opacity.toFixed(3);
        });
      };

      updateWheel(0);

      if (ruleTopRef.current && ruleBottomRef.current) {
        gsap.fromTo(
          [ruleTopRef.current, ruleBottomRef.current],
          { scaleX: 0 },
          {
            scaleX: 1,
            ease: "power2.out",
            scrollTrigger: {
              trigger: track,
              start: "top 75%",
              end: "top 18%",
              scrub: true,
            },
          }
        );
      }

      ScrollTrigger.create({
        trigger: track,
        start: "top top",
        end: "bottom bottom",
        scrub: 0.35,
        invalidateOnRefresh: true,
        onUpdate: (self) => updateWheel(self.progress),
        onToggle: (self) => onTuckChange?.(self.isActive),
      });
    }, rootRef);

    return () => {
      onTuckChange?.(false);
      ctx.revert();
    };
  }, [drumEnabled, onTuckChange]);

  const current = CAPABILITIES_DRUM[activeIndex] ?? CAPABILITIES_DRUM[0];

  return (
    <section id="capabilities" ref={rootRef} className="drum-scene" aria-labelledby="capabilities-title">
      <div className="wrap section-head">
        <span className="eyebrow" data-enter="">
          <Compass size={18} weight="duotone" aria-hidden="true" />
          <span>Built in</span>
        </span>
        <h2 id="capabilities-title" data-enter="" style={{ "--enter-i": 1 } as CSSProperties}>
          What your agent gets out of the box.
        </h2>
        <p className="lede" data-enter="" style={{ "--enter-i": 2 } as CSSProperties}>
          Instead of brittle scripts or empty test browsers, one install gives every coding agent real Chrome control.
        </p>
      </div>

      {drumEnabled ? (
        <div ref={trackRef} className="scene drum-track is-live">
          <div className="scene-stage drum-stage">
            <div className="drum-viewport">
              <div className="drum-window" aria-hidden="true">
                <div ref={glowRef} className="drum-glow" />
                <span ref={ruleTopRef} className="drum-rule drum-rule--top" />
                <span ref={ruleBottomRef} className="drum-rule drum-rule--bottom" />
                <span ref={leftPtrRef} className="drum-pointer drum-pointer--left" />
                <span
                  ref={rightPtrRef}
                  className="drum-pointer drum-pointer--right"
                  data-cursor-target="drum-detent"
                  data-cursor-anchor="2.4,0.5"
                />
              </div>

              <ul className="drum-list" aria-label="Included browser capabilities">
                {CAPABILITIES_DRUM.map((cap, idx) => (
                  <li
                    key={cap.id}
                    ref={(el) => {
                      itemRefs.current[idx] = el;
                    }}
                    className={`drum-item ${idx === activeIndex ? "is-active" : ""}`}
                  >
                    {cap.title}
                  </li>
                ))}
              </ul>
            </div>

            <div className="drum-foot">
              <span className="mono font-medium">
                {String(activeIndex + 1).padStart(2, "0")} of {CAPABILITIES_DRUM.length}
              </span>
              <span>{current.summary}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="wrap">
          <ul className="cells drum-static-grid" data-enter="scale">
            {CAPABILITIES_DRUM.map((cap) => (
              <li key={cap.id} className="p-5 sm:p-6">
                <h3 className="text-[16.5px] font-semibold tracking-tight text-[var(--text)] m-0">
                  {cap.title}
                </h3>
                <p className="mt-1.5 mb-0 text-[14.5px] text-[var(--text-2)]">{cap.summary}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
