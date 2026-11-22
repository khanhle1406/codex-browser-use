interface AgentCursorProps {
  className?: string;
  label?: string;
  showRipple?: boolean;
  rippleClassName?: string;
}

// Original repo rounded-arrow cursor path (`xt`) from mcp-server/extension/content-script.js
const REPO_CURSOR_PATH =
  "M3.04536 4.45259C2.7582 3.60299 3.60299 2.7582 4.45259 3.04536L14.1828 6.33403C15.1637 6.66558 15.0872 8.08006 14.0715 8.39045L10.2994 9.54319C9.93919 9.65327 9.65327 9.93919 9.54319 10.2994L8.39046 14.0715C8.08007 15.1637 6.66558 15.1637 6.33404 14.1828L3.04536 4.45259Z";

export function AgentCursor({
  className = "",
  label = "Agent",
  showRipple = true,
  rippleClassName = "cbu-cursor-ripple",
}: AgentCursorProps) {
  return (
    <div className={`cbu-cursor ${className}`.trim()} aria-hidden="true">
      {showRipple && <span className={rippleClassName} />}
      <svg
        width="26"
        height="28"
        viewBox="0 0 23 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="cbu-cursor-svg"
      >
        <path
          d={REPO_CURSOR_PATH}
          fill="#000000"
          stroke="#ffffff"
          strokeWidth="3.2"
          strokeLinejoin="round"
          paintOrder="stroke fill"
          transform="translate(0.86 0.86) scale(1.22)"
        />
      </svg>
      {label ? <span className="cbu-cursor-badge">{label}</span> : null}
    </div>
  );
}

export function ChromeTrafficLights() {
  return (
    <span className="flex items-center gap-1.5 shrink-0" aria-hidden="true">
      <i className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]/90 inline-block" />
      <i className="w-2.5 h-2.5 rounded-full bg-[#febc2e]/90 inline-block" />
      <i className="w-2.5 h-2.5 rounded-full bg-[#28c840]/90 inline-block" />
    </span>
  );
}
