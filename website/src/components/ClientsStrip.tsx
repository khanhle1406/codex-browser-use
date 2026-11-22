import type { CSSProperties } from "react";
import { CLIENT_LOGOS } from "../data/product";
import { useCursorChoreography } from "../lib/cursorDirector";
import { AgentBrandIcon } from "./AgentBrandIcons";

export function ClientsStrip() {
  const { activeClientIdx } = useCursorChoreography();

  return (
    <section className="clients-bar wrap-wide" aria-labelledby="clients-heading">
      <h2 id="clients-heading" className="clients-label" data-enter="fade">
        Works in the agent you already use
      </h2>
      <ul className="cells clients-grid" data-enter="scale">
        {CLIENT_LOGOS.map((client, idx) => {
          const isCursorActive = activeClientIdx === idx;
          return (
            <li key={client.id} style={{ "--enter-i": idx } as CSSProperties}>
              <a
                href={client.url}
                target="_blank"
                rel="noopener noreferrer"
                className="client-cell"
                data-cursor-target={`client-${idx}`}
                data-cursor-anchor="0.5,0.44"
                data-cursor-active={isCursorActive ? "true" : undefined}
                aria-label={client.name}
              >
                <span className="client-icon" aria-hidden="true">
                  <AgentBrandIcon id={client.id} size={28} />
                </span>
                <span>{client.name}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
