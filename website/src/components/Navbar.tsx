import { ArrowRight, GithubLogo, List, Moon, Sun } from "@phosphor-icons/react";
import { REPO_URL } from "../data/product";

export type NavTone = "hero" | "paper" | "dark";

interface NavbarProps {
  tone: NavTone;
  tucked: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

const NAV_LINKS = [
  { href: "#features", label: "Features" },
  { href: "#speed", label: "Speed" },
  { href: "#install", label: "Install" },
  { href: "#faq", label: "FAQ" },
];

export function Navbar({ tone, tucked, theme, onToggleTheme }: NavbarProps) {
  const isPaper = tone === "paper";
  const closePopover = () => {
    const el = document.getElementById("site-menu") as (HTMLElement & { hidePopover?: () => void }) | null;
    el?.hidePopover?.();
  };

  return (
    <header>
      <nav
        aria-label="Main"
        className={`nav ${isPaper ? "is-paper" : ""}`}
        data-tucked={tucked ? "true" : undefined}
      >
        <a href="#top" className="nav-logo" aria-label="codex-browser-use home">
          <img src="./assets/logo.png" alt="" width={22} height={22} />
          <span>browser-use</span>
        </a>

        <div className="nav-links">
          {NAV_LINKS.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </div>

        <div className="nav-end">
          <button
            type="button"
            className="nav-icon-btn"
            onClick={onToggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? (
              <Sun size={18} weight="bold" aria-hidden="true" />
            ) : (
              <Moon size={18} weight="bold" aria-hidden="true" />
            )}
          </button>

          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="nav-gh"
            aria-label="codex-browser-use repository on GitHub"
          >
            <GithubLogo size={16} weight="fill" aria-hidden="true" />
            <span>GitHub</span>
          </a>

          <button
            type="button"
            className="nav-icon-btn nav-menu-btn"
            aria-label="Open menu"
            aria-controls="site-menu"
            popoverTarget="site-menu"
            popoverTargetAction="toggle"
          >
            <List size={18} weight="bold" aria-hidden="true" />
          </button>
        </div>
      </nav>

      <ul
        id="site-menu"
        className="site-menu-popover"
        {...({ popover: "auto" } as Record<string, string>)}
      >
        {NAV_LINKS.map((item) => (
          <li key={item.href}>
            <a href={item.href} onClick={closePopover}>
              <span>{item.label}</span>
              <ArrowRight size={14} weight="bold" aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </header>
  );
}
