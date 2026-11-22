import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import { INSTALL_METHODS } from "../data/product";
import { useCursorChoreography } from "../lib/cursorDirector";

export function InstallSection() {
  const [activeIndex, setActiveIndex] = useState(0);
  const { installReady } = useCursorChoreography();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const panelsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = panelsRef.current;
    if (!el) return;
    const onMatch = (event: Event) => {
      const panel = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-tab-index]");
      const idx = Number(panel?.dataset.tabIndex);
      if (Number.isInteger(idx)) setActiveIndex(idx);
    };
    el.addEventListener("beforematch", onMatch);
    return () => el.removeEventListener("beforematch", onMatch);
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") {
      return;
    }
    event.preventDefault();
    const total = INSTALL_METHODS.length;
    let next = activeIndex;
    if (event.key === "ArrowRight") next = (activeIndex + 1) % total;
    else if (event.key === "ArrowLeft") next = (activeIndex - 1 + total) % total;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = total - 1;
    setActiveIndex(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <section id="install" className="section wrap" aria-labelledby="install-title">
      <div className="section-head">
        <h2 id="install-title" data-enter="">
          Set up in under a minute.
        </h2>
        <p className="lede" data-enter="" style={{ "--enter-i": 1 } as CSSProperties}>
          Works with Node.js 26+ and Chrome, Edge or Brave. Nothing to pay for and no API keys required.
        </p>
      </div>

      <div className="surface install-card" data-enter="scale" style={{ "--enter-i": 2 } as CSSProperties}>
        <div
          className="tablist"
          role="tablist"
          aria-label="Coding agent clients"
          onKeyDown={handleKeyDown}
          {...({ focusgroup: "tablist nomemory" } as Record<string, string>)}
        >
          {INSTALL_METHODS.map((method, idx) => {
            const selected = idx === activeIndex;
            return (
              <button
                key={method.id}
                ref={(el) => {
                  tabRefs.current[idx] = el;
                }}
                type="button"
                role="tab"
                id={`install-tab-${method.id}`}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className="tab-btn"
                onClick={() => setActiveIndex(idx)}
                {...(selected ? { focusgroupstart: "" } : {})}
              >
                {method.label}
              </button>
            );
          })}
        </div>

        <div ref={panelsRef} className="tab-panels-grid">
          {INSTALL_METHODS.map((method, idx) => {
            const selected = idx === activeIndex;
            const codeId = `install-code-${method.id}`;
            const statusId = `install-status-${method.id}`;

            return (
              <div
                key={method.id}
                data-tab-index={idx}
                role="tabpanel"
                aria-labelledby={`install-tab-${method.id}`}
                tabIndex={selected ? 0 : undefined}
                hidden={selected ? undefined : ("until-found" as unknown as boolean)}
              >
                <div className="tab-panel-inner">
                  <div className="cli-wrap w-full">
                    <button
                      type="button"
                      className="cli-btn group w-full justify-between"
                      aria-label={`Copy ${method.label} setup command`}
                      aria-describedby={statusId}
                      {...({
                        command: "--copy",
                        commandfor: codeId,
                      } as Record<string, string>)}
                    >
                      <code id={codeId} data-copy-value={method.command}>
                        <span className="cli-prompt">$</span>
                        {method.command}
                      </code>
                      <span
                        data-cursor-target={selected ? "install-copy" : undefined}
                        data-cursor-anchor="0.5,0.5"
                        data-step-hit={selected && installReady ? "true" : undefined}
                        className="cli-copy-chip"
                        aria-hidden="true"
                      >
                        <Copy size={14} weight="bold" className="group-data-[copied=true]:hidden" />
                        <Check size={14} weight="bold" className="hidden group-data-[copied=true]:block" />
                      </span>
                    </button>
                    <span id={statusId} className="copy-toast" role="status" />
                  </div>

                  <p className="mt-4 mb-0 text-[14.5px] leading-relaxed text-[var(--text-2)]">
                    {method.noteBefore}
                    <code className="px-1.5 py-0.5 rounded-md bg-[var(--sunk)] text-[var(--text)] text-[13px]">
                      {method.noteCode}
                    </code>
                    {method.noteAfter}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-6 pt-5 border-t border-[var(--hair)] grid grid-cols-1 sm:grid-cols-2 gap-4 text-[14px] text-[var(--text-2)]">
          <div>
            <strong className="text-[var(--text)] font-semibold block mb-1">
              1. Load the extension in Chrome
            </strong>
            <span>
              Open <code className="text-[13px] px-1 rounded bg-[var(--sunk)] text-[var(--text)]">chrome://extensions</code>, turn on Developer mode, and load <code className="text-[13px] px-1 rounded bg-[var(--sunk)] text-[var(--text)]">~/.local/share/browser-use/extension</code>.
            </span>
          </div>
          <div>
            <strong className="text-[var(--text)] font-semibold block mb-1">
              2. Restart your agent
            </strong>
            <span>
              Reopen your editor or CLI once and ask it to open or check any page in Chrome.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
