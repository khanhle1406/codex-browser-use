import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ArrowRight, Check, Copy } from "@phosphor-icons/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { HERO_CLI_COMMAND, HERO_SHOWCASE_TABS } from "../data/product";
import { notifyActiveHeroTab } from "../lib/cursorDirector";
import { HeroBrowserScene } from "./HeroBrowserScenes";

gsap.registerPlugin(ScrollTrigger);

const HEADLINE_LINES = [
  ["Give", "any", "AI", "agent"],
  ["your", "real", "Chrome."],
];

export function Hero() {
  const [tabState, setTabState] = useState<{
    active: number;
    previous: number | null;
    dir: "next" | "back";
    turned: boolean;
  }>({ active: 0, previous: null, dir: "next", turned: false });

  const heroRef = useRef<HTMLElement>(null);
  const heroTopRef = useRef<HTMLDivElement>(null);
  const heroCopyRef = useRef<HTMLDivElement>(null);
  const frameSceneRef = useRef<HTMLDivElement>(null);
  const heroFrameRef = useRef<HTMLDivElement>(null);

  const tablistRef = useRef<HTMLDivElement>(null);
  const chipSpanRef = useRef<HTMLSpanElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const panelsRef = useRef<HTMLDivElement>(null);

  const selectTab = useCallback((next: number) => {
    const nextTab = HERO_SHOWCASE_TABS[next];
    if (nextTab) notifyActiveHeroTab(nextTab.id);
    setTabState((prev) =>
      next === prev.active
        ? prev
        : {
            active: next,
            previous: prev.active,
            dir: next > prev.active ? "next" : "back",
            turned: true,
          }
    );
  }, []);

  useEffect(() => {
    const mm = gsap.matchMedia();

    mm.add(
      {
        motion: "(prefers-reduced-motion: no-preference)",
        desktop: "(min-width: 768px)",
      },
      (context) => {
        const { motion, desktop } = context.conditions ?? {};
        if (!motion) return undefined;

        const frame = heroFrameRef.current;
        const frameScene = frameSceneRef.current;
        const heroTop = heroTopRef.current;
        const heroCopy = heroCopyRef.current;

        // 3D perspective un-tilt scrub as showcase scrolls toward focus (matching tasteskill.dev)
        if (frame && frameScene) {
          gsap.fromTo(
            frame,
            {
              y: desktop ? 24 : 10,
              rotateX: desktop ? 11 : 4,
              scale: desktop ? 0.96 : 0.98,
            },
            {
              y: 0,
              rotateX: 0,
              scale: 1,
              ease: "none",
              scrollTrigger: {
                trigger: frameScene,
                start: "top 95%",
                end: desktop ? "top 24%" : "top 40%",
                scrub: 0.45,
                invalidateOnRefresh: true,
              },
            }
          );
        }

        // Gentle staggered copy drift as hero scrolls upward past viewport
        if (heroTop && heroCopy && desktop) {
          const children = Array.from(heroCopy.children) as HTMLElement[];
          const drifts = [-60, -38, -22];
          children.forEach((el, idx) => {
            gsap.to(el, {
              y: drifts[idx] ?? -24,
              opacity: 0.35,
              ease: "none",
              scrollTrigger: {
                trigger: heroTop,
                start: "top top",
                end: "bottom 18%",
                scrub: 0.35,
                invalidateOnRefresh: true,
              },
            });
          });
        }

        return undefined;
      },
      heroRef
    );

    return () => mm.revert();
  }, []);

  useEffect(() => {
    const el = panelsRef.current;
    if (!el) return;
    const onMatch = (event: Event) => {
      const panel = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-tab-index]");
      const idx = Number(panel?.dataset.tabIndex);
      if (Number.isInteger(idx)) selectTab(idx);
    };
    el.addEventListener("beforematch", onMatch);
    return () => el.removeEventListener("beforematch", onMatch);
  }, [selectTab]);

  useEffect(() => {
    const list = tablistRef.current;
    const chip = chipSpanRef.current;
    if (!list || !chip) return;

    const updateChip = () => {
      const btn = tabRefs.current[tabState.active];
      if (!btn) return;
      const totalWidth = list.scrollWidth;
      const totalHeight = list.clientHeight;
      chip.style.width = `${totalWidth}px`;
      const right = Math.max(0, totalWidth - btn.offsetLeft - btn.offsetWidth);
      const bottom = Math.max(0, totalHeight - btn.offsetTop - btn.offsetHeight);
      chip.style.clipPath = `inset(${btn.offsetTop}px ${right}px ${bottom}px ${btn.offsetLeft}px round 9px)`;
    };

    updateChip();
    const ro = new ResizeObserver(updateChip);
    ro.observe(list);
    return () => ro.disconnect();
  }, [tabState.active]);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") {
      return;
    }
    event.preventDefault();
    const total = HERO_SHOWCASE_TABS.length;
    let next = tabState.active;
    if (event.key === "ArrowRight") next = (tabState.active + 1) % total;
    else if (event.key === "ArrowLeft") next = (tabState.active - 1 + total) % total;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = total - 1;
    selectTab(next);
    tabRefs.current[next]?.focus();
  };

  let wordIdx = 0;
  const activeTab = HERO_SHOWCASE_TABS[tabState.active] ?? HERO_SHOWCASE_TABS[0];

  return (
    <section id="top" ref={heroRef} className="hero" aria-labelledby="hero-title">
      <div ref={heroTopRef} className="hero-top">
        <div className="hero-glow" aria-hidden="true">
          <div className="hero-sun">
            <div className="hero-sun-core" />
          </div>
        </div>

        <div ref={heroCopyRef} className="hero-copy">
          <h1 id="hero-title">
            {HEADLINE_LINES.map((words, li) => (
              <span key={li} className="hero-title-line">
                {words.map((word, wi) => {
                  const idx = wordIdx++;
                  return (
                    <span key={`${word}-${idx}`}>
                      <span className="hero-word" style={{ "--wi": idx } as CSSProperties}>
                        <span>{word}</span>
                      </span>
                      {wi < words.length - 1 ? " " : ""}
                    </span>
                  );
                })}
                {li < HEADLINE_LINES.length - 1 ? " " : ""}
              </span>
            ))}
          </h1>

          <p className="hero-sub">
            One local bridge lets Claude Code, Codex and Cursor use the Chrome you are already signed in to, cleanly and fast.
          </p>

          <div className="hero-actions">
            <div className="cli-wrap">
              <button
                type="button"
                className="cli-btn group"
                aria-label={`Copy command: ${HERO_CLI_COMMAND}`}
                aria-describedby="hero-copy-status"
                {...({
                  command: "--copy",
                  commandfor: "hero-cli-code",
                } as Record<string, string>)}
              >
                <code id="hero-cli-code" data-copy-value={HERO_CLI_COMMAND}>
                  <span className="cli-prompt">$</span>
                  {HERO_CLI_COMMAND}
                </code>
                <span className="cli-copy-chip" aria-hidden="true">
                  <Copy size={14} weight="bold" className="group-data-[copied=true]:hidden" />
                  <Check size={14} weight="bold" className="hidden group-data-[copied=true]:block" />
                </span>
              </button>
              <span id="hero-copy-status" className="copy-toast" role="status" />
            </div>

            <a href="#install" className="btn btn-white">
              <span>Quick start</span>
              <ArrowRight size={16} weight="bold" aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>

      <div className="hero-work">
        <div className="hero-tabs-wrap">
          <div className="relative inline-flex items-center max-w-full">
            <div
              ref={tablistRef}
              className="hero-tabs"
              role="tablist"
              aria-label="Product views"
              onKeyDown={handleTabKeyDown}
              {...({ focusgroup: "tablist nomemory" } as Record<string, string>)}
            >
              <span className="tabs-chip" aria-hidden="true">
                <span ref={chipSpanRef} />
              </span>

              {HERO_SHOWCASE_TABS.map((tab, idx) => {
                const selected = idx === tabState.active;
                return (
                  <button
                    key={tab.id}
                    ref={(el) => {
                      tabRefs.current[idx] = el;
                    }}
                    type="button"
                    role="tab"
                    id={`hero-tab-${tab.id}`}
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    className="hero-tab"
                    onClick={() => selectTab(idx)}
                    {...(selected ? { focusgroupstart: "" } : {})}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
            <span
              data-cursor-target="hero-park"
              data-cursor-anchor="0.5,0.5"
              className="hero-park-beacon"
              aria-hidden="true"
            />
          </div>
        </div>

        <div ref={frameSceneRef} className="hero-frame-scene">
          <div ref={heroFrameRef} className="hero-frame">
            <div ref={panelsRef} className="hero-screen" data-dir={tabState.dir}>
              {HERO_SHOWCASE_TABS.map((tab, idx) => {
                const selected = idx === tabState.active;
                const state = selected ? "on" : idx === tabState.previous ? "off" : "idle";
                return (
                  <div
                    key={tab.id}
                    data-tab-index={idx}
                    role="tabpanel"
                    aria-labelledby={`hero-tab-${tab.id}`}
                    tabIndex={selected ? 0 : undefined}
                    className="work-shot"
                    data-state={state}
                    data-turned={tabState.turned ? "true" : undefined}
                    hidden={selected ? undefined : ("until-found" as unknown as boolean)}
                  >
                    <HeroBrowserScene id={tab.id} active={selected} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <p className="hero-caption">{activeTab.caption}</p>
      </div>
    </section>
  );
}
