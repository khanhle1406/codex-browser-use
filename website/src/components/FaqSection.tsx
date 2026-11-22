import type { CSSProperties } from "react";
import { FAQ_ITEMS } from "../data/product";

export function FaqSection() {
  return (
    <section id="faq" className="section wrap" aria-labelledby="faq-title">
      <div className="section-head">
        <h2 id="faq-title" data-enter="">
          Common questions.
        </h2>
      </div>

      <div className="cells faq" data-enter="scale" style={{ "--enter-i": 1 } as CSSProperties}>
        {FAQ_ITEMS.map((item) => (
          <div key={item.question}>
            <h3>{item.question}</h3>
            <p>{item.answer}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
