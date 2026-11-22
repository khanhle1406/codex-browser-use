import { useEffect, useRef, type CSSProperties } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { CheckCircle, HandPalm, ShieldCheck } from "@phosphor-icons/react";
import { FEATURE_CARDS, ISOLATION_HIGHLIGHTS } from "../data/product";
import { OneRunFeatureArt, RealChromeFeatureArt, TabIsolationSimulator } from "./FeatureArtScenes";

gsap.registerPlugin(ScrollTrigger);

const ISOLATION_ICONS = [CheckCircle, ShieldCheck, HandPalm];

export function FeaturesSection() {
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const mm = gsap.matchMedia();

    mm.add(
      {
        motion: "(prefers-reduced-motion: no-preference)",
        phone: "(max-width: 767px)",
      },
      (context) => {
        const { motion, phone } = context.conditions ?? {};
        if (!motion) return;

        const cards = gsap.utils.toArray<HTMLElement>(".feature", rootRef.current);
        const shift = phone ? 8 : 18;

        cards.forEach((card) => {
          const art = card.querySelector<HTMLElement>(".feature-art");
          const bg = card.querySelector<HTMLElement>(".fx-bg");
          const floatBox = card.querySelector<HTMLElement>(".feat-float");
          const rings = card.querySelector<HTMLElement>(".fx-rings");
          const glow = card.querySelector<HTMLElement>(".fx-glow");
          const linesX = card.querySelectorAll<HTMLElement>(".fx-t, .fx-b");
          const linesY = card.querySelectorAll<HTMLElement>(".fx-l, .fx-r");
          const marks = card.querySelectorAll<HTMLElement>(".fx-mark");

          if (art) {
            gsap.fromTo(
              art,
              { clipPath: phone ? "inset(4% 5% 4% 5% round 16px)" : "inset(10% 10% 10% 10% round 16px)" },
              {
                clipPath: "inset(0% 0% 0% 0% round 22px)",
                ease: "none",
                scrollTrigger: {
                  trigger: card,
                  start: "top bottom",
                  end: phone ? "top 58%" : "top 48%",
                  scrub: true,
                },
              }
            );
          }

          if (bg) {
            gsap.fromTo(
              bg,
              { scale: 1.24 },
              {
                scale: 1,
                ease: "none",
                scrollTrigger: {
                  trigger: card,
                  start: "top bottom",
                  end: phone ? "top 58%" : "top 48%",
                  scrub: true,
                },
              }
            );
          }

          if (linesX.length) {
            gsap.fromTo(
              linesX,
              { scaleX: 0 },
              {
                scaleX: 1,
                duration: 0.9,
                ease: "power3.out",
                stagger: 0.08,
                scrollTrigger: { trigger: card, start: "top 82%", once: true },
              }
            );
          }

          if (linesY.length) {
            gsap.fromTo(
              linesY,
              { scaleY: 0 },
              {
                scaleY: 1,
                duration: 0.9,
                ease: "power3.out",
                stagger: 0.08,
                scrollTrigger: { trigger: card, start: "top 82%", once: true },
              }
            );
          }

          if (marks.length) {
            gsap.fromTo(
              marks,
              { opacity: 0, scale: 0.6 },
              {
                opacity: 1,
                scale: 1,
                duration: 0.6,
                ease: "power2.out",
                stagger: 0.05,
                scrollTrigger: { trigger: card, start: "top 82%", once: true },
              }
            );
          }

          if (glow) {
            gsap.fromTo(
              glow,
              { opacity: 0.25, scale: 0.85 },
              {
                opacity: 1,
                scale: 1,
                duration: 1,
                ease: "power2.out",
                scrollTrigger: { trigger: card, start: "top 84%", once: true },
              }
            );
          }

          if (floatBox) {
            gsap.fromTo(
              floatBox,
              { y: shift },
              {
                y: -shift,
                ease: "none",
                scrollTrigger: {
                  trigger: card,
                  start: "top bottom",
                  end: "bottom top",
                  scrub: true,
                },
              }
            );
          }

          if (rings) {
            gsap.fromTo(
              rings,
              { y: -shift * 0.6 },
              {
                y: shift * 0.6,
                ease: "none",
                scrollTrigger: {
                  trigger: card,
                  start: "top bottom",
                  end: "bottom top",
                  scrub: true,
                },
              }
            );
          }
        });
      },
      rootRef
    );

    return () => mm.revert();
  }, []);

  return (
    <section id="features" ref={rootRef} className="section wrap-wide" aria-labelledby="features-title">
      <div className="section-head">
        <h2 id="features-title" data-enter="">
          Built for real Chrome, not empty clones.
        </h2>
        <p className="lede" data-enter="" style={{ "--enter-i": 1 } as CSSProperties}>
          Your browser already has your logins, extensions and open projects ready.
        </p>
      </div>

      <div className="feats">
        {FEATURE_CARDS.map((card) => (
          <article key={card.id} className={`surface feature ${card.flip ? "flip" : ""}`} data-enter="scale">
            <div className="feature-art">
              <div className={`fx-bg ${card.darkArt ? "fx-bg--dark" : ""}`} aria-hidden="true" />
              <div className="fx-glow" aria-hidden="true" />
              <div className="fx-rings" aria-hidden="true">
                <div className="fx-ring" />
                <div className="fx-ring fx-ring-2" />
              </div>
              <span className="fx-line fx-t" aria-hidden="true" />
              <span className="fx-line fx-b" aria-hidden="true" />
              <span className="fx-line fx-l" aria-hidden="true" />
              <span className="fx-line fx-r" aria-hidden="true" />
              <span className="fx-mark fx-m1" aria-hidden="true" />
              <span className="fx-mark fx-m2" aria-hidden="true" />
              <span className="fx-mark fx-m3" aria-hidden="true" />
              <span className="fx-mark fx-m4" aria-hidden="true" />

              {card.id === "real-chrome" ? <RealChromeFeatureArt /> : <OneRunFeatureArt />}
            </div>

            <div className="feature-copy">
              <span className="feat-label">{card.label}</span>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
              <span className="feat-meta">{card.metaTag}</span>
            </div>
          </article>
        ))}

        {/* Wide full-width interactive isolation card breaks zigzag alternation */}
        <article data-cursor-section="isolation" className="surface overflow-hidden p-2 sm:p-3" data-enter="scale">
          <TabIsolationSimulator />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 px-4 py-7 sm:px-8 sm:py-8">
            {ISOLATION_HIGHLIGHTS.map((item, idx) => {
              const Icon = ISOLATION_ICONS[idx % ISOLATION_ICONS.length];
              return (
                <div key={item.title} className="flex flex-col gap-2">
                  <div className="inline-flex items-center gap-2 text-[var(--label)] text-[14.5px] font-semibold">
                    <Icon size={18} weight="duotone" aria-hidden="true" />
                    <span>{item.title}</span>
                  </div>
                  <p className="text-[15px] leading-relaxed text-[var(--text-2)] m-0">{item.body}</p>
                </div>
              );
            })}
          </div>
        </article>
      </div>
    </section>
  );
}
