import type { CSSProperties } from "react";
import { ArrowUpRight, Gauge } from "@phosphor-icons/react";
import { KEY_NUMBERS, REPO_URL } from "../data/product";
import { useCursorChoreography } from "../lib/cursorDirector";

export function KeyNumbersStrip() {
  const { activeSpeedIdx } = useCursorChoreography();

  return (
    <section id="speed" className="section wrap-wide" aria-labelledby="speed-title">
      <div className="section-head">
        <span className="eyebrow" data-enter="">
          <Gauge size={18} weight="duotone" aria-hidden="true" />
          <span>Speed</span>
        </span>
        <h2 id="speed-title" data-enter="" style={{ "--enter-i": 1 } as CSSProperties}>
          Three numbers that matter.
        </h2>
        <p className="lede" data-enter="" style={{ "--enter-i": 2 } as CSSProperties}>
          Measured side by side on real Chrome workflows with the exact same AI model.
        </p>
      </div>

      <ul className="cells grid-cols-1 md:grid-cols-3" data-enter="scale">
        {KEY_NUMBERS.map((item, idx) => (
          <li
            key={item.id}
            data-cursor-target={`speed-${idx}`}
            data-cursor-anchor="0.82,0.22"
            data-cursor-active={activeSpeedIdx === idx ? "true" : undefined}
            className="speed-cell p-8 sm:p-10 flex flex-col justify-between gap-4"
          >
            <div className="mono text-[44px] sm:text-[52px] font-semibold tracking-tight text-[var(--accent)] leading-none">
              {item.value}
            </div>
            <div>
              <h3 className="text-[18px] font-semibold tracking-tight text-[var(--text)] m-0">
                {item.label}
              </h3>
              <p className="mt-2 mb-0 text-[15px] leading-relaxed text-[var(--text-2)]">
                {item.detail}
              </p>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex justify-center" data-enter="fade">
        <a
          href={`${REPO_URL}#why-its-better`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[14.5px] font-medium text-[var(--text-2)] hover:text-[var(--text)] transition-colors no-underline"
        >
          <span>See full benchmark methodology on GitHub</span>
          <ArrowUpRight size={15} weight="bold" aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}
