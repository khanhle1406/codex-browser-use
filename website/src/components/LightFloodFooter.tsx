import { useEffect, useRef } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { HERO_CLI_COMMAND, REPO_URL } from "../data/product";

gsap.registerPlugin(ScrollTrigger);

interface LightFloodFooterProps {
  onTuckChange?: (tucked: boolean) => void;
  onFooterDark?: (dark: boolean) => void;
}

const WORDMARK_CHARS = [..."browser-use"];

export function LightFloodFooter({ onTuckChange, onFooterDark }: LightFloodFooterProps) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const cobaltLayerRef = useRef<HTMLDivElement>(null);
  const nightLayerRef = useRef<HTMLDivElement>(null);
  const haloRef = useRef<HTMLDivElement>(null);
  const keyTextRef = useRef<HTMLSpanElement>(null);
  const leadTextRef = useRef<HTMLSpanElement>(null);

  const sunriseRef = useRef<HTMLDivElement>(null);
  const sunriseGlowRef = useRef<HTMLDivElement>(null);
  const letterRefs = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    const mm = gsap.matchMedia();

    mm.add(
      {
        motion: "(prefers-reduced-motion: no-preference)",
        phone: "(max-width: 767px)",
      },
      (context) => {
        const { motion, phone } = context.conditions ?? {};
        const scene = sceneRef.current;
        const sunrise = sunriseRef.current;

        if (!motion) {
          onTuckChange?.(false);
          if (scene) {
            ScrollTrigger.create({
              trigger: scene,
              start: "bottom 120px",
              end: "max",
              onEnter: () => onFooterDark?.(true),
              onLeaveBack: () => onFooterDark?.(false),
            });
          }
          return undefined;
        }

        if (scene) {
          const tl = gsap.timeline({
            scrollTrigger: {
              trigger: scene,
              start: "top top",
              end: "bottom bottom",
              scrub: true,
              invalidateOnRefresh: true,
              onToggle: (self) => onTuckChange?.(self.isActive),
              onUpdate: (self) => onFooterDark?.(self.progress > 0.62),
            },
          });

          tl.fromTo(
            haloRef.current,
            { scale: 0.72, opacity: 0.35, yPercent: 20 },
            { scale: 1.45, opacity: 0.95, yPercent: -25, duration: 0.5 },
            0
          )
            .fromTo(cobaltLayerRef.current, { opacity: 0 }, { opacity: 1, duration: 0.45 }, 0.15)
            .to(leadTextRef.current, { color: "#ffffff", duration: 0.28 }, 0.16)
            .fromTo(
              keyTextRef.current,
              { opacity: 0.35, y: 12, color: "#2563eb" },
              { opacity: 1, y: 0, color: "#ffffff", duration: 0.35 },
              0.16
            )
            .fromTo(nightLayerRef.current, { opacity: 0 }, { opacity: 1, duration: 0.45 }, 0.58)
            .to(leadTextRef.current, { opacity: 0.65, color: "#93c5fd", duration: 0.4 }, 0.6);
        }

        if (sunrise) {
          const letters = letterRefs.current.filter((el): el is HTMLSpanElement => el !== null);
          gsap.set(letters, { yPercent: 105 });

          const sTl = gsap.timeline({
            defaults: { ease: "none" },
            scrollTrigger: {
              trigger: sunrise,
              start: "clamp(top bottom)",
              end: "max",
              scrub: phone ? 0.35 : 0.6,
              invalidateOnRefresh: true,
            },
          });

          sTl.fromTo(
            sunriseGlowRef.current,
            { yPercent: 14, scaleX: 0.72, scaleY: 0.42, opacity: 0.55 },
            { yPercent: 0, scaleX: 1, scaleY: 1, opacity: 1, duration: 1, ease: "power2.out" },
            0
          ).to(
            letters,
            {
              yPercent: 0,
              duration: 0.55,
              ease: "power3.out",
              stagger: { each: phone ? 0.03 : 0.04, from: "center" },
            },
            0.12
          );

          ScrollTrigger.create({
            trigger: sunrise,
            start: "top bottom",
            end: "bottom top",
            onToggle: (self) => sunrise.toggleAttribute("data-awake", self.isActive),
          });
        }

        return () => {
          onTuckChange?.(false);
          onFooterDark?.(false);
          sunrise?.removeAttribute("data-awake");
        };
      },
      sceneRef
    );

    return () => mm.revert();
  }, [onFooterDark, onTuckChange]);

  return (
    <>
      <div
        id="light-flood"
        ref={sceneRef}
        className="scene is-live"
        data-scene="light-flood"
        aria-labelledby="closing-statement"
      >
        <div className="scene-stage lf-stage">
          <div ref={cobaltLayerRef} className="lf-cobalt-layer" aria-hidden="true" />
          <div ref={haloRef} className="lf-halo" aria-hidden="true" />
          <div ref={nightLayerRef} className="lf-night-layer" aria-hidden="true" />

          <div className="lf-words">
            <h2 id="closing-statement">
              <span ref={leadTextRef} className="lf-lead">
                Stop opening blank browsers,
              </span>
              <span ref={keyTextRef} className="lf-key">
                use your real one.
              </span>
            </h2>
          </div>
        </div>
      </div>

      <footer className="site-footer">
        <div className="foot-cta wrap">
          <h2>Install codex-browser-use in one command.</h2>
          <p>Free, open-source MIT software. Runs locally on Node.js and your own Chrome.</p>

          <div className="cli-wrap mt-7">
            <button
              type="button"
              className="cli-btn group"
              aria-label={`Copy command: ${HERO_CLI_COMMAND}`}
              aria-describedby="footer-copy-status"
              {...({
                command: "--copy",
                commandfor: "footer-cli-code",
              } as Record<string, string>)}
            >
              <code id="footer-cli-code" data-copy-value={HERO_CLI_COMMAND}>
                <span className="cli-prompt">$</span>
                {HERO_CLI_COMMAND}
              </code>
              <span className="cli-copy-chip" aria-hidden="true">
                <Copy size={14} weight="bold" className="group-data-[copied=true]:hidden" />
                <Check size={14} weight="bold" className="hidden group-data-[copied=true]:block" />
              </span>
            </button>
            <span id="footer-copy-status" className="copy-toast" role="status" />
          </div>
        </div>

        <div className="wrap-wide foot-grid">
          <div className="flex flex-col gap-3">
            <a href="#top" className="nav-logo" aria-label="Back to top">
              <img src="./assets/logo.png" alt="" width={22} height={22} loading="lazy" />
              <span>codex-browser-use</span>
            </a>
            <p className="text-[14px] text-[#ebf3ff]/75 max-w-[28ch] m-0">
              Your real Chrome browser for any AI coding agent. MIT Licensed.
            </p>
          </div>

          <nav className="foot-col" aria-label="Product">
            <h3>Product</h3>
            <ul>
              <li>
                <a href="#features">Features</a>
              </li>
              <li>
                <a href="#speed">Speed</a>
              </li>
              <li>
                <a href="#install">Quick install</a>
              </li>
              <li>
                <a href="#faq">Common questions</a>
              </li>
            </ul>
          </nav>

          <nav className="foot-col" aria-label="Guides">
            <h3>Guides</h3>
            <ul>
              <li>
                <a href={`${REPO_URL}/blob/main/skill/SKILL.md`} target="_blank" rel="noopener noreferrer">
                  Agent Skill Guide
                </a>
              </li>
              <li>
                <a href={`${REPO_URL}/blob/main/skill/references/cookbook.md`} target="_blank" rel="noopener noreferrer">
                  Workflow Cookbook
                </a>
              </li>
              <li>
                <a href={`${REPO_URL}/blob/main/skill/references/tools.md`} target="_blank" rel="noopener noreferrer">
                  Tool Reference
                </a>
              </li>
            </ul>
          </nav>

          <nav className="foot-col" aria-label="Open Source">
            <h3>Open Source</h3>
            <ul>
              <li>
                <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
                  GitHub Repository
                </a>
              </li>
              <li>
                <a href={`${REPO_URL}/issues`} target="_blank" rel="noopener noreferrer">
                  Issues
                </a>
              </li>
              <li>
                <a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">
                  MIT License
                </a>
              </li>
            </ul>
          </nav>
        </div>

        {/* Signature giant glowing horizon wordmark inspired by tasteskill.dev */}
        <div ref={sunriseRef} className="foot-sunrise" aria-hidden="true">
          <div ref={sunriseGlowRef} className="fs-glow" />
          <p className="fs-word">
            {WORDMARK_CHARS.map((ch, idx) => (
              <span
                key={`${ch}-${idx}`}
                ref={(el) => {
                  letterRefs.current[idx] = el;
                }}
                className={ch === " " ? "fs-gap" : undefined}
              >
                {ch === " " ? "\u00a0" : ch}
              </span>
            ))}
          </p>
        </div>
      </footer>
    </>
  );
}
