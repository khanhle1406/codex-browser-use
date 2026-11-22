import { useEffect, useRef, useState } from "react";
import { Check, CursorClick, LockSimple, WarningCircle } from "@phosphor-icons/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { BEFORE_AFTER_STEPS } from "../data/product";
import { notifyManualBeforeAfterStep, useCursorChoreography } from "../lib/cursorDirector";
import { scrollToY } from "../lib/stage";
import { AgentCursor } from "./AgentCursor";
import { ChromeWindow } from "./ChromeWindow";

gsap.registerPlugin(ScrollTrigger);

const STEP_MQ = "(prefers-reduced-motion: no-preference) and (min-width: 960px)";

export function BeforeAfterShowcase() {
  const rootRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const railRefs = useRef<Array<HTMLElement | null>>([]);
  const triggerRef = useRef<ScrollTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const { enabled: roaming, baSubStep } = useCursorChoreography();

  useEffect(() => {
    notifyManualBeforeAfterStep(activeIndex);
  }, [activeIndex]);

  useEffect(() => {
    const mm = gsap.matchMedia();

    mm.add(STEP_MQ, () => {
      const track = trackRef.current;
      if (!track) return undefined;

      const total = BEFORE_AFTER_STEPS.length;
      const syncRails = (progress: number) => {
        const scaled = progress * total;
        const active = Math.min(total - 1, Math.floor(scaled));
        setActiveIndex((prev) => (prev === active ? prev : active));

        railRefs.current.forEach((bar, i) => {
          if (!bar) return;
          const fill = Math.min(1, Math.max(0, scaled - i));
          bar.style.transform = `scaleY(${fill.toFixed(3)})`;
        });
      };

      syncRails(0);

      const trigger = ScrollTrigger.create({
        trigger: track,
        start: "top top",
        end: "bottom bottom",
        scrub: 0.25,
        invalidateOnRefresh: true,
        onUpdate: (self) => syncRails(self.progress),
      });
      triggerRef.current = trigger;

      return () => {
        trigger.kill();
        triggerRef.current = null;
      };
    }, rootRef);

    return () => mm.revert();
  }, []);

  const handleSelectStep = (idx: number) => {
    setActiveIndex(idx);
    railRefs.current.forEach((bar, i) => {
      if (!bar) return;
      bar.style.transform = i <= idx ? "scaleY(1)" : "scaleY(0)";
    });
    const trigger = triggerRef.current;
    if (trigger) {
      const targetProgress = idx === 0 ? 0.02 : (idx + 0.35) / BEFORE_AFTER_STEPS.length;
      const y = trigger.start + targetProgress * (trigger.end - trigger.start);
      scrollToY(y, 1.0);
    }
  };

  const active = BEFORE_AFTER_STEPS[activeIndex] ?? BEFORE_AFTER_STEPS[0];
  const isUsualWay = activeIndex === 0;
  const hasGroup = activeIndex >= 1;
  const hasNumbers = activeIndex >= 2;
  const isDone = activeIndex >= 3;
  const filterClicked =
    (hasNumbers && roaming && (baSubStep === "filter-1" || baSubStep === "export-2" || baSubStep === "run-3")) ||
    isDone;
  const exportClicked =
    (hasNumbers && roaming && (baSubStep === "export-2" || baSubStep === "run-3")) || isDone;

  return (
    <section id="before-after" ref={rootRef} className="section" aria-labelledby="ba-title">
      <div ref={trackRef} className="scene ba-track is-live">
        <div className="scene-stage ba-stage">
          <div className="ba-grid">
            <div>
              <span className="ba-chip ba-chip--inline" aria-hidden="true">
                {active.chipLabel}
              </span>
              <h2 id="ba-title" className="h2">
                From slow restarts to one clean flow.
              </h2>

              <ol className="ba-steps">
                {BEFORE_AFTER_STEPS.map((step, idx) => {
                  const isActive = idx === activeIndex;
                  return (
                    <li key={step.id} className={`ba-step ${isActive ? "is-active" : ""}`}>
                      <span className="ba-rail" aria-hidden="true">
                        <i
                          ref={(el) => {
                            railRefs.current[idx] = el;
                          }}
                          style={{ transform: idx === 0 ? "scaleY(1)" : "scaleY(0)" }}
                        />
                      </span>
                      <button
                        type="button"
                        aria-current={isActive ? "step" : undefined}
                        onClick={() => handleSelectStep(idx)}
                      >
                        <span className="ba-title">{step.title}</span>
                        {isActive && <span className="ba-desc">{step.summary}</span>}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>

            {/* Live Photorealistic Chromium Cold-Test vs Signed-in Real Chrome */}
            <div className="ba-frame">
              <div className="ba-screen">
                <ChromeWindow
                  variant={isUsualWay ? "cold-test" : "light"}
                  loading={hasNumbers && !isDone && exportClicked}
                  profileLabel="M"
                  showBookmarks={!isUsualWay}
                  showAutomationBanner={isUsualWay}
                  automationTargetId={isUsualWay ? "ba-locked" : undefined}
                  extensionStatus={isUsualWay ? "none" : "connected"}
                  standaloneActiveTab={isUsualWay ? { title: "Sign in - Kestrel", icon: "lock" } : undefined}
                  personalTabs={
                    !isUsualWay
                      ? [
                          { title: "Gmail", icon: "gmail" },
                          { title: "Docs", icon: "docs" },
                        ]
                      : []
                  }
                  tabGroups={
                    hasGroup
                      ? [
                          {
                            label: "App QA",
                            color: isDone ? "green" : "blue",
                            targetId: "ba-group",
                            anchor: "0.75,0.5",
                            tabs: [
                              {
                                title: "Orders - Kestrel",
                                icon: "orders",
                                active: true,
                                badge: isDone ? "deliverable" : "active",
                              },
                            ],
                          },
                        ]
                      : []
                  }
                  url={
                    isUsualWay
                      ? { protocol: "https://", host: "auth.kestrel.io", path: "/login" }
                      : { protocol: "https://", host: "app.kestrel.io", path: "/orders" }
                  }
                  downloadBadge={
                    !isUsualWay ? { filename: "paid-invoices.csv · 12.4 KB", active: exportClicked } : undefined
                  }
                  downloadHighlight={!isUsualWay && exportClicked}
                >
                  <div
                    className={`relative flex-1 min-h-0 p-4 sm:p-5 flex flex-col justify-between transition-colors duration-300 ${
                      isUsualWay ? "bg-[#191b24] text-[#e2e8f0]" : "bg-white text-[#0b1220]"
                    }`}
                  >
                    {!roaming && hasNumbers && (
                      <AgentCursor
                        className={isDone ? "cbu-cursor-ba cbu-cursor-ba--done" : "cbu-cursor-ba"}
                        label="Agent"
                        showRipple
                      />
                    )}

                    {isUsualWay ? (
                      <>
                        {/* Step 0: Real Sign-In Wall inside Blank Guest Chromium */}
                        <div className="flex-1 flex items-center justify-center py-2">
                          <div className="w-full max-w-[330px] rounded-xl bg-[#222633] border border-white/10 p-4 shadow-xl space-y-3">
                            <div className="flex items-center gap-2">
                              <span className="w-6 h-6 rounded-md bg-amber-500/20 text-amber-300 grid place-items-center shrink-0">
                                <LockSimple size={13} weight="bold" aria-hidden="true" />
                              </span>
                              <div>
                                <div className="text-[13px] font-semibold text-white">
                                  Sign in to Kestrel
                                </div>
                                <div className="text-[10.5px] text-white/55">
                                  Empty Playwright/Puppeteer browser profile
                                </div>
                              </div>
                            </div>

                            <div className="rounded-lg bg-amber-500/12 border border-amber-400/30 px-2.5 py-2 flex items-start gap-2 text-[11px] text-amber-200">
                              <WarningCircle size={14} weight="fill" className="text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
                              <span>Session expired · Sign in &amp; 2FA required before opening /orders</span>
                            </div>

                            <div className="space-y-2 text-[11px]">
                              <div className="rounded-lg bg-[#181b25] border border-white/10 px-2.5 py-1.5 text-white/40">
                                Email address
                              </div>
                              <div className="rounded-lg bg-[#181b25] border border-white/10 px-2.5 py-1.5 text-white/40">
                                Password
                              </div>
                            </div>

                            <div className="flex items-center justify-between pt-1">
                              <span className="text-[10.5px] text-white/45">No saved cookies</span>
                              <span
                                data-cursor-target="ba-3"
                                data-cursor-anchor="0.5,0.5"
                                className="px-3 py-1.5 rounded-lg bg-white/10 text-white/60 text-[11.5px] font-semibold"
                              >
                                Sign in
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="pt-2.5 border-t border-white/10 flex flex-wrap items-center justify-between gap-2 text-[11px] text-white/65 mono">
                          <span>Blank profile · Raw HTML dump: 214 KB (~54k tokens)</span>
                          <span className="text-amber-300 font-semibold">Blocked on login</span>
                        </div>
                      </>
                    ) : (
                      <>
                        {/* Steps 1 to 3: Signed-In Orders Workspace inside Real Chrome */}
                        <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-[#090e1a]/10">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                            <span className="text-[13px] font-semibold truncate">
                              Orders · minh@kestrel.io
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {isDone ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700">
                                <Check size={11} weight="bold" aria-hidden="true" />
                                <span>Done in 1 run</span>
                              </span>
                            ) : (
                              <span className="text-[10.5px] font-medium px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                                Session active
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Interactive Orders Toolbar */}
                        <div className="flex flex-wrap items-center justify-between gap-2 my-2">
                          <button
                            type="button"
                            tabIndex={-1}
                            data-cursor-target="ba-1"
                            data-cursor-anchor="0.5,0.5"
                            className={`rounded-lg px-2.5 py-1.5 flex items-center gap-1.5 border text-[11.5px] font-semibold transition-all duration-200 ${
                              filterClicked
                                ? "bg-[#e8f0fe] border-[#1a73e8] text-[#1a73e8] shadow-[0_0_0_2px_rgba(26,115,232,0.16)]"
                                : "bg-[#f8fafc] border-[#090e1a]/12 text-[#0b1220]"
                            }`}
                          >
                            <span>{filterClicked ? "Filter: Paid only (2)" : "Status: All (3)"}</span>
                            {hasNumbers && (
                              <span className="mono text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#1a73e8] text-white inline-flex items-center gap-0.5">
                                {filterClicked && <Check size={9} weight="bold" aria-hidden="true" />}
                                <span>[1]</span>
                              </span>
                            )}
                          </button>

                          <button
                            type="button"
                            tabIndex={-1}
                            data-cursor-target="ba-2"
                            data-cursor-anchor="0.5,0.5"
                            className={`rounded-lg px-2.5 py-1.5 flex items-center gap-1.5 border text-[11.5px] font-semibold transition-all duration-200 ${
                              exportClicked
                                ? "bg-emerald-50 border-emerald-400 text-emerald-800"
                                : "bg-[#f8fafc] border-[#090e1a]/12 text-[#0b1220]"
                            }`}
                          >
                            <span>{exportClicked ? "Exported 2 rows" : "Export CSV"}</span>
                            {hasNumbers && (
                              <span
                                className={`mono text-[10px] font-semibold px-1.5 py-0.5 rounded text-white inline-flex items-center gap-0.5 ${
                                  exportClicked ? "bg-emerald-600" : "bg-[#1a73e8]"
                                }`}
                              >
                                {exportClicked && <Check size={9} weight="bold" aria-hidden="true" />}
                                <span>[2]</span>
                              </span>
                            )}
                          </button>
                        </div>

                        {/* Semantic Data Table */}
                        <div
                          tabIndex={0}
                          role="region"
                          aria-label="Kestrel orders table"
                          className="rounded-xl border border-[#090e1a]/10 bg-white overflow-x-auto"
                        >
                          <table className="w-full text-left border-collapse text-[11px] tabular-nums">
                            <thead>
                              <tr className="bg-[#f8fafc] border-b border-[#090e1a]/8 text-[#0b1220]/55 text-[10px]">
                                <th scope="col" className="py-1.5 px-2.5 font-medium">
                                  Order
                                </th>
                                <th scope="col" className="py-1.5 px-2 font-medium">
                                  Customer
                                </th>
                                <th scope="col" className="py-1.5 px-2 font-medium">
                                  Status
                                </th>
                                <th scope="col" className="py-1.5 px-2.5 font-medium text-right">
                                  Amount
                                </th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-[#090e1a]/6">
                              <tr>
                                <td className="py-1.5 px-2.5 mono text-[#0b1220]/65">#1042</td>
                                <td className="py-1.5 px-2 font-medium text-[#0b1220]">Halcyon Audio</td>
                                <td className="py-1.5 px-2 text-emerald-700 font-semibold">Paid</td>
                                <td className="py-1.5 px-2.5 text-right font-semibold mono text-[#0b1220]">
                                  $1,248.50
                                </td>
                              </tr>
                              <tr
                                className={`transition-all duration-300 ${
                                  filterClicked ? "opacity-30 line-through" : ""
                                }`}
                              >
                                <td className="py-1.5 px-2.5 mono text-[#0b1220]/65">#1043</td>
                                <td className="py-1.5 px-2 font-medium text-[#0b1220]">Meridian Bio</td>
                                <td className="py-1.5 px-2 text-amber-700 font-semibold">Pending</td>
                                <td className="py-1.5 px-2.5 text-right font-semibold mono text-[#0b1220]">
                                  $680.00
                                </td>
                              </tr>
                              <tr className="hidden sm:table-row">
                                <td className="py-1.5 px-2.5 mono text-[#0b1220]/65">#1044</td>
                                <td className="py-1.5 px-2 font-medium text-[#0b1220]">Vektor Labs</td>
                                <td className="py-1.5 px-2 text-emerald-700 font-semibold">Paid</td>
                                <td className="py-1.5 px-2.5 text-right font-semibold mono text-[#0b1220]">
                                  $2,140.00
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 mt-auto">
                          <span className="text-[11px] text-[#0b1220]/65 mono">
                            {isDone
                              ? "1 script call · 1.4s · 2 temp tabs closed"
                              : hasNumbers
                                ? "Compact outline: 1.4 KB (3 interactive refs)"
                                : "Signed-in session reused · No login wall"}
                          </span>

                          <span
                            data-cursor-target="ba-3"
                            data-cursor-anchor="0.5,0.5"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors duration-200 text-white"
                            style={{
                              background: isDone ? "#16a34a" : "#1a73e8",
                            }}
                          >
                            {isDone ? (
                              <Check size={13} weight="bold" aria-hidden="true" />
                            ) : (
                              <CursorClick size={13} weight="bold" aria-hidden="true" />
                            )}
                            <span>
                              {isDone ? "Done · Saved" : hasNumbers ? "Save report [3]" : "Continue"}
                            </span>
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                </ChromeWindow>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
