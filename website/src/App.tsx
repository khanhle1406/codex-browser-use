import { useCallback, useEffect, useState } from "react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { gsap } from "gsap";
import { initCopyCommands } from "./lib/copyCommand";
import { initSmoothStage } from "./lib/stage";
import { Navbar, type NavTone } from "./components/Navbar";
import { Hero } from "./components/Hero";
import { ClientsStrip } from "./components/ClientsStrip";
import { CapabilitiesDrum } from "./components/CapabilitiesDrum";
import { FeaturesSection } from "./components/FeaturesSection";
import { BeforeAfterShowcase } from "./components/BeforeAfterShowcase";
import { KeyNumbersStrip } from "./components/KeyNumbersStrip";
import { InstallSection } from "./components/InstallSection";
import { FaqSection } from "./components/FaqSection";
import { LightFloodFooter } from "./components/LightFloodFooter";
import { RoamingRepoCursor } from "./components/RoamingRepoCursor";

gsap.registerPlugin(ScrollTrigger);

export function App() {
  const [tone, setTone] = useState<NavTone>("hero");
  const [drumTucked, setDrumTucked] = useState(false);
  const [floodTucked, setFloodTucked] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof document !== "undefined") {
      return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    }
    return "light";
  });

  useEffect(() => {
    const cleanupCopy = initCopyCommands();
    const cleanupStage = initSmoothStage();

    const ctx = gsap.context(() => {
      const heroTop = document.querySelector<HTMLElement>(".hero-top");
      if (heroTop) {
        ScrollTrigger.create({
          trigger: heroTop,
          start: "top top",
          end: "bottom 72px",
          invalidateOnRefresh: true,
          onLeave: () => setTone("paper"),
          onEnterBack: () => setTone("hero"),
        });
      }
      ScrollTrigger.refresh();
    });

    return () => {
      ctx.revert();
      cleanupStage();
      cleanupCopy();
    };
  }, []);

  const handleFooterDark = useCallback((isDark: boolean) => {
    setTone((prev) => {
      if (prev === "hero") return prev;
      return isDark ? "dark" : "paper";
    });
  }, []);

  const handleToggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("cbu-theme", next);
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  };

  return (
    <>
      <Navbar
        tone={tone}
        tucked={drumTucked || floodTucked}
        theme={theme}
        onToggleTheme={handleToggleTheme}
      />
      <RoamingRepoCursor />
      <div className="w-full max-w-full overflow-x-clip">
        <main>
          <Hero />
          <ClientsStrip />
          <CapabilitiesDrum onTuckChange={setDrumTucked} />
          <FeaturesSection />
          <BeforeAfterShowcase />
          <KeyNumbersStrip />
          <InstallSection />
          <FaqSection />
        </main>
        <LightFloodFooter onTuckChange={setFloodTucked} onFooterDark={handleFooterDark} />
      </div>
    </>
  );
}

export default App;
