import type { ReactNode } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  CaretDown,
  DotsThreeVertical,
  DownloadSimple,
  Info,
  Plus,
  PuzzlePiece,
  SlidersHorizontal,
  Star,
  User,
  X,
} from "@phosphor-icons/react";

export type ChromeVariant = "light" | "dark" | "cold-test";
export type ChromeFaviconKind =
  | "gmail"
  | "docs"
  | "calendar"
  | "linear"
  | "figma"
  | "stripe"
  | "acme"
  | "orders"
  | "checkout"
  | "report"
  | "deploy"
  | "lock"
  | "chrome";

export type ChromeBadgeKind = "active" | "deliverable" | "handoff";

export interface ChromeTabItem {
  title: string;
  active?: boolean;
  icon?: ChromeFaviconKind;
  badge?: ChromeBadgeKind;
}

export interface ChromeTabGroup {
  label: string;
  color: "blue" | "green" | "amber";
  targetId?: string;
  anchor?: string;
  tabs: ChromeTabItem[];
}

export interface ChromePersonalTab {
  title: string;
  icon: ChromeFaviconKind;
}

export interface ChromeWindowProps {
  variant?: ChromeVariant;
  personalTabs?: ChromePersonalTab[];
  tabGroups?: ChromeTabGroup[];
  standaloneActiveTab?: { title: string; icon?: ChromeFaviconKind; badge?: ChromeBadgeKind };
  url: { protocol?: string; host: string; path?: string };
  showBookmarks?: boolean;
  showAutomationBanner?: boolean;
  automationTargetId?: string;
  extensionStatus?: "connected" | "paused" | "none";
  profileLabel?: string;
  profileTargetId?: string;
  profilePopover?: boolean;
  loading?: boolean;
  downloadBadge?: {
    filename: string;
    active?: boolean;
    targetId?: string;
  };
  downloadHighlight?: boolean;
  toolbarRightSlot?: ReactNode;
  subToolbarSlot?: ReactNode;
  compact?: boolean;
  className?: string;
  children: ReactNode;
}

// Exact small pointer path used on real Chrome tab favicons in extension content-script.js
const FAVICON_ARROW_PATH =
  "M3.04536 4.45259C2.7582 3.60299 3.60299 2.7582 4.45259 3.04536L14.1828 6.33403C15.1637 6.66558 15.0872 8.08006 14.0715 8.39045L10.2994 9.54319C9.93919 9.65327 9.65327 9.93919 9.54319 10.2994L8.39046 14.0715C8.08007 15.1637 6.66558 15.1637 6.33404 14.1828L3.04536 4.45259Z";

function BaseFavicon({ kind }: { kind: ChromeFaviconKind }) {
  switch (kind) {
    case "gmail":
      return (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <rect x="1.5" y="3" width="13" height="10" rx="2" fill="#ffffff" />
          <path d="M2 4.5v7.8c0 .4.3.7.7.7H4V7.4L8 10l4-2.6V13h1.3c.4 0 .7-.3.7-.7V4.5c0-.9-1-1.4-1.7-.9L8 6.7 3.7 3.6C3 3.1 2 3.6 2 4.5Z" fill="#ea4335" />
          <path d="M2 4.5v7.8c0 .4.3.7.7.7H4V7.4L2 5.9Z" fill="#4285f4" />
          <path d="M14 4.5v7.8c0 .4-.3.7-.7.7H12V7.4l2-1.5Z" fill="#34a853" />
        </svg>
      );
    case "docs":
      return (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path d="M3.5 1.5h6l3 3v10a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z" fill="#4285f4" />
          <path d="M9.5 1.5v3h3l-3-3Z" fill="#a8c7fa" />
          <rect x="5" y="7" width="6" height="1.2" rx=".5" fill="#fff" />
          <rect x="5" y="9.4" width="6" height="1.2" rx=".5" fill="#fff" />
          <rect x="5" y="11.8" width="4" height="1.2" rx=".5" fill="#fff" />
        </svg>
      );
    case "calendar":
      return (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <rect x="2" y="2" width="12" height="12" rx="2.5" fill="#ffffff" stroke="#1a73e8" strokeWidth="1.5" />
          <rect x="2" y="2" width="12" height="3.5" rx="1" fill="#1a73e8" />
          <text x="8" y="12" textAnchor="middle" fontSize="6.5" fontWeight="700" fill="#1a73e8">21</text>
        </svg>
      );
    case "linear":
      return (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <circle cx="8" cy="8" r="6" fill="#5e6ad2" />
          <path d="M4.2 9.4 6.6 11.8M4.6 6.8l4.6 4.6M6.8 4.6l4.6 4.6" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case "figma":
      return (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <circle cx="9.8" cy="8" r="2" fill="#1abcfe" />
          <path d="M6.2 2.5H8v3.5H6.2a1.75 1.75 0 0 1 0-3.5Z" fill="#f24e1e" />
          <path d="M8 2.5h1.8a1.75 1.75 0 0 1 0 3.5H8V2.5Z" fill="#ff7262" />
          <path d="M6.2 6H8v3.5H6.2a1.75 1.75 0 0 1 0-3.5Z" fill="#a259ff" />
          <path d="M6.2 9.5H8v1.75a1.75 1.75 0 1 1-1.8-1.75Z" fill="#0acf83" />
        </svg>
      );
    case "stripe":
      return (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <rect x="2" y="2" width="12" height="12" rx="3" fill="#635bff" />
          <path d="M6.2 6.6c0-.8.7-1.2 1.8-1.2 1 0 1.8.3 2.3.7V4.6c-.6-.3-1.4-.5-2.3-.5-2 0-3.3 1-3.3 2.6 0 2.5 3.4 2.1 3.4 3.2 0 .6-.5 1-1.5 1-1 0-2-.4-2.7-.9v1.5c.8.4 1.8.6 2.7.6 2 0 3.4-.9 3.4-2.6 0-2.7-3.8-2.2-3.8-2.9Z" fill="#fff" />
        </svg>
      );
    case "orders":
    case "acme":
    case "deploy":
    case "checkout":
    case "report": {
      const bg =
        kind === "report"
          ? "#10b981"
          : kind === "deploy"
            ? "#3b82f6"
            : kind === "checkout"
              ? "#6366f1"
              : "#2563eb";
      const letter = kind === "orders" ? "O" : kind === "report" ? "Q" : kind === "deploy" ? "D" : "K";
      return (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill={bg} />
          <text x="8" y="11" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="#ffffff" fontFamily="system-ui">
            {letter}
          </text>
        </svg>
      );
    }
    case "lock":
      return (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <rect x="3" y="7" width="10" height="7" rx="2" fill="#f59e0b" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="#f59e0b" strokeWidth="1.6" fill="none" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <circle cx="8" cy="8" r="6" fill="#2563eb" />
          <circle cx="8" cy="8" r="2.6" fill="#ffffff" />
        </svg>
      );
  }
}

export function ChromeFavicon({
  kind = "acme",
  badge,
}: {
  kind?: ChromeFaviconKind;
  badge?: ChromeBadgeKind;
}) {
  return (
    <span className="chrome-favicon-wrap" aria-hidden="true">
      <BaseFavicon kind={kind} />
      {badge === "active" && (
        <svg viewBox="0 0 16 16" width="11" height="11" className="chrome-favicon-badge-svg">
          <path
            d={FAVICON_ARROW_PATH}
            fill="#000000"
            stroke="#ffffff"
            strokeWidth="2.2"
            strokeLinejoin="round"
            paintOrder="stroke fill"
            transform="translate(2 2) scale(0.75)"
          />
        </svg>
      )}
      {badge === "deliverable" && <span className="chrome-favicon-dot chrome-favicon-dot--green" />}
      {badge === "handoff" && <span className="chrome-favicon-dot chrome-favicon-dot--amber" />}
    </span>
  );
}

export function ChromeWindow({
  variant = "light",
  personalTabs = [],
  tabGroups = [],
  standaloneActiveTab,
  url,
  showBookmarks = false,
  showAutomationBanner = false,
  automationTargetId,
  extensionStatus = "connected",
  profileLabel = "M",
  profileTargetId,
  profilePopover = false,
  loading = false,
  downloadBadge,
  downloadHighlight = false,
  toolbarRightSlot,
  subToolbarSlot,
  compact = false,
  className = "",
  children,
}: ChromeWindowProps) {
  return (
    <div
      className={`chrome-win chrome-win--${variant} ${compact ? "chrome-win--compact" : ""} ${className}`.trim()}
    >
      {/* 1. Authentic macOS Chrome Tab Strip */}
      <div className="chrome-tabstrip">
        <div className="chrome-window-controls" aria-hidden="true">
          <span className="chrome-tl-row">
            <i className="chrome-tl chrome-tl--close" />
            <i className="chrome-tl chrome-tl--min" />
            <i className="chrome-tl chrome-tl--max" />
          </span>
          <span className="chrome-tabsearch-btn">
            <CaretDown size={10} weight="bold" />
          </span>
        </div>

        <div className="chrome-tabs-row">
          {personalTabs.map((pt, idx) => (
            <div key={`${pt.title}-${idx}`} className="chrome-tab chrome-tab--inactive">
              <ChromeFavicon kind={pt.icon} />
              <span className="chrome-tab-title">{pt.title}</span>
              <X size={10} weight="bold" className="chrome-tab-close" aria-hidden="true" />
              <span className="chrome-tab-sep" aria-hidden="true" />
            </div>
          ))}

          {tabGroups.map((group) => (
            <div
              key={group.label}
              data-cursor-target={group.targetId}
              data-cursor-anchor={group.anchor ?? "0.5,0.5"}
              className={`chrome-group chrome-group--${group.color}`}
            >
              <span className="chrome-group-chip">{group.label}</span>
              {group.tabs.map((tab) => (
                <div
                  key={tab.title}
                  className={`chrome-tab ${tab.active ? "chrome-tab--active" : "chrome-tab--inactive"}`}
                >
                  <ChromeFavicon kind={tab.icon ?? "acme"} badge={tab.badge} />
                  <span className="chrome-tab-title">{tab.title}</span>
                  <X size={10} weight="bold" className="chrome-tab-close" aria-hidden="true" />
                </div>
              ))}
              <span className="chrome-group-rail" aria-hidden="true" />
            </div>
          ))}

          {standaloneActiveTab && (
            <div className="chrome-tab chrome-tab--active">
              <ChromeFavicon kind={standaloneActiveTab.icon ?? "chrome"} badge={standaloneActiveTab.badge} />
              <span className="chrome-tab-title">{standaloneActiveTab.title}</span>
              <X size={10} weight="bold" className="chrome-tab-close" aria-hidden="true" />
            </div>
          )}

          <span className="chrome-newtab-btn" aria-hidden="true">
            <Plus size={12} weight="bold" />
          </span>
        </div>
      </div>

      {/* 2. Authentic Chrome Refresh Toolbar & Omnibox */}
      <div className="chrome-toolbar">
        <div className="chrome-nav-btns" aria-hidden="true">
          <span className="chrome-nav-btn">
            <ArrowLeft size={13} weight="bold" />
          </span>
          <span className="chrome-nav-btn is-muted">
            <ArrowRight size={13} weight="bold" />
          </span>
          <span className="chrome-nav-btn">
            <ArrowClockwise size={13} weight="bold" />
          </span>
        </div>

        <div className="chrome-omnibox">
          <span className="chrome-tune-btn" aria-hidden="true">
            <SlidersHorizontal size={11} weight="bold" />
          </span>
          <div className="chrome-url-text">
            {url.protocol && <span className="chrome-url-muted">{url.protocol}</span>}
            <span className="chrome-url-host">{url.host}</span>
            {url.path && <span className="chrome-url-muted">{url.path}</span>}
          </div>
          <span className="chrome-star-btn" aria-hidden="true">
            <Star size={12} weight="regular" />
          </span>
        </div>

        <div className="chrome-toolbar-right">
          {toolbarRightSlot}

          {downloadBadge && (
            <div
              data-cursor-target={downloadBadge.targetId}
              data-cursor-anchor="0.5,0.5"
              className={`chrome-ext-btn chrome-dl-anchor ${
                downloadHighlight || downloadBadge.active ? "is-highlighted" : ""
              }`}
              aria-hidden="true"
            >
              <DownloadSimple
                size={14}
                weight="bold"
                className={downloadBadge.active || downloadHighlight ? "text-[#1a73e8]" : ""}
              />
              {downloadBadge.active && (
                <div className="chrome-download-pop">
                  <span className="chrome-download-dot" />
                  <span>{downloadBadge.filename}</span>
                </div>
              )}
            </div>
          )}

          {extensionStatus !== "none" && (
            <div className="chrome-extensions-cluster" aria-hidden="true">
              <span className="chrome-ext-btn chrome-ext-pinned" title="codex-browser-use">
                <img src="./assets/logo.png" alt="" width={14} height={14} />
                <span
                  className={`chrome-ext-dot ${
                    extensionStatus === "paused" ? "chrome-ext-dot--amber" : "chrome-ext-dot--green"
                  }`}
                />
              </span>
              <span className="chrome-ext-btn chrome-puzzle-btn">
                <PuzzlePiece size={13.5} weight="duotone" />
              </span>
            </div>
          )}

          <span className="chrome-toolbar-divider" aria-hidden="true" />

          <div className="relative inline-flex items-center">
            <span
              data-cursor-target={profileTargetId}
              data-cursor-anchor="0.5,0.5"
              className={`chrome-profile-avatar ${variant === "cold-test" ? "is-guest" : ""} ${
                profilePopover ? "ring-2 ring-[#8ab4f8]" : ""
              }`}
              aria-hidden="true"
            >
              {variant === "cold-test" ? <User size={11} weight="bold" /> : profileLabel}
            </span>
            {profilePopover && (
              <div className="chrome-profile-popover" aria-hidden="true">
                <div className="chrome-profile-pop-head">
                  <span className="chrome-profile-pop-dot" />
                  <span>Minh Tran · Work Profile</span>
                </div>
                <div className="chrome-profile-pop-sub">Sync on · 38 cookies &amp; DevTools active</div>
              </div>
            )}
          </div>

          <span className="chrome-nav-btn" aria-hidden="true">
            <DotsThreeVertical size={13} weight="bold" />
          </span>
        </div>
        {loading && <span className="chrome-load-bar" aria-hidden="true" />}
      </div>

      {/* 3. Optional Bookmarks Bar (proves it is the user's real signed-in Chrome) */}
      {showBookmarks && (
        <div className="chrome-bookmarks" aria-hidden="true">
          {[
            { label: "Gmail", icon: "gmail" as const },
            { label: "Linear", icon: "linear" as const },
            { label: "localhost:3000", icon: "deploy" as const },
            { label: "Stripe Dashboard", icon: "stripe" as const },
          ].map((bm) => (
            <span key={bm.label} className="chrome-bookmark-item">
              <BaseFavicon kind={bm.icon} />
              <span>{bm.label}</span>
            </span>
          ))}
        </div>
      )}

      {/* Optional secondary toolbar strip (e.g. simulator pill controls) */}
      {subToolbarSlot}

      {/* 4. Classic Chromium test automation infobar (Step 0 Before comparison) */}
      {showAutomationBanner && (
        <div
          data-cursor-target={automationTargetId}
          data-cursor-anchor="0.88,0.5"
          className="chrome-infobar--automation"
        >
          <span className="flex items-center gap-1.5 min-w-0">
            <Info size={13} weight="fill" className="shrink-0" aria-hidden="true" />
            <span className="truncate">Chrome is being controlled by automated test software.</span>
          </span>
          <X size={11} weight="bold" className="shrink-0 opacity-60" aria-hidden="true" />
        </div>
      )}

      {/* 5. Edge-to-Edge Realistic Web App Viewport */}
      <div className="chrome-viewport">{children}</div>
    </div>
  );
}
