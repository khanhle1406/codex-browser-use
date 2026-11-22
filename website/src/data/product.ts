export interface ShowcaseTab {
  id: string;
  label: string;
  image: string;
  alt: string;
  caption: string;
}

export interface AgentLogo {
  id: string;
  name: string;
  url: string;
}

export interface CapabilityItem {
  id: string;
  title: string;
  summary: string;
}

export interface FeatureCardData {
  id: string;
  label: string;
  title: string;
  body: string;
  metaTag: string;
  image: string;
  alt: string;
  darkArt?: boolean;
  flip?: boolean;
}

export interface BeforeAfterStep {
  id: string;
  title: string;
  summary: string;
  chipLabel: string;
}

export interface KeyNumberItem {
  id: string;
  value: string;
  label: string;
  detail: string;
}

export interface InstallMethod {
  id: string;
  label: string;
  command: string;
  noteBefore: string;
  noteCode: string;
  noteAfter: string;
}

export interface FaqItem {
  question: string;
  answer: string;
}

export const HERO_CLI_COMMAND = "node mcp-server/bin/browser-use.js install --skill";

export const REPO_URL = "https://github.com/khanhle1406/codex-browser-use";

export const HERO_SHOWCASE_TABS: ShowcaseTab[] = [
  {
    id: "live-chrome",
    label: "Live Chrome",
    image: "./assets/hero-live-chrome.jpg",
    alt: "Real Chrome window showing a clean App QA tab group and a glowing agent pointer near interactive controls",
    caption: "Runs inside your signed-in Chrome so cookies and sessions stay intact.",
  },
  {
    id: "tab-groups",
    label: "Tab Groups",
    image: "./assets/how-it-works-isolation.png",
    alt: "Colored Chrome Tab Groups keeping personal tabs untouched while isolating agent tabs",
    caption: "Each agent works inside its own colored Tab Group, separate from your tabs.",
  },
  {
    id: "one-call",
    label: "One-Call Flow",
    image: "./assets/how-it-works-workflow.png",
    alt: "Workflow diagram showing one script reading updates and acting cleanly",
    caption: "Handles multi-step clicks, forms and downloads in a single pass.",
  },
  {
    id: "architecture",
    label: "Local Bridge",
    image: "./assets/how-it-works-architecture.png",
    alt: "Direct local bridge connecting your coding agent directly to a real Chrome tab",
    caption: "Runs offline on your computer with zero cloud servers.",
  },
];

export const CLIENT_LOGOS: AgentLogo[] = [
  { id: "antigravity", name: "Antigravity", url: "https://antigravity.google/" },
  { id: "claude", name: "Claude Code", url: "https://claude.com/product/claude-code" },
  { id: "codex", name: "Codex", url: "https://openai.com/codex/" },
  { id: "cursor", name: "Cursor", url: "https://cursor.com/" },
  { id: "windsurf", name: "Windsurf", url: "https://windsurf.com/" },
  { id: "copilot", name: "Copilot", url: "https://github.com/features/copilot/cli" },
  { id: "commandcode", name: "Command Code", url: "https://commandcode.ai/" },
  { id: "opencode", name: "OpenCode", url: "https://opencode.ai/" },
];

export const CAPABILITIES_DRUM: CapabilityItem[] = [
  { id: "real-chrome", title: "Uses your real Chrome", summary: "Keeps your logins and extensions ready" },
  { id: "stays-signed-in", title: "No cold restarts", summary: "Never downloads an empty second browser" },
  { id: "leaves-tabs-alone", title: "Leaves your tabs alone", summary: "Works inside colored Tab Groups only" },
  { id: "clean-page-map", title: "Clean page outline", summary: "Short numbered targets instead of raw HTML" },
  { id: "one-run", title: "Full flow in one turn", summary: "Clicks, loops and exports in one script" },
  { id: "parallel-tabs", title: "Opens tabs side by side", summary: "Reads multiple pages at once when needed" },
  { id: "tricky-forms", title: "Handles rich editors", summary: "Fills modern web apps and file pickers" },
  { id: "saves-files", title: "Saves output to disk", summary: "Exports clean screenshots and JSON locally" },
  { id: "pauses-safely", title: "Pauses for logins", summary: "Stops cleanly at 2FA or CAPTCHA prompts" },
  { id: "open-source", title: "100% local and free", summary: "MIT licensed, zero cloud accounts needed" },
];

export const FEATURE_CARDS: FeatureCardData[] = [
  {
    id: "real-chrome",
    label: "Your browser",
    title: "No extra browser to download.",
    body: "Connects straight to the Chrome you already have open, so your cookies, local accounts and extensions work from the first click.",
    metaTag: "Zero extra browsers",
    image: "./assets/how-it-works-architecture.png",
    alt: "Diagram showing an AI agent connecting locally to your running Chrome browser",
    darkArt: true,
  },
  {
    id: "one-run",
    label: "Built for speed",
    title: "One run instead of twenty turns.",
    body: "Your agent finishes multi-step flows, waits for pages to settle and saves files in a single script instead of pausing after every action.",
    metaTag: "One continuous flow",
    image: "./assets/how-it-works-workflow.png",
    alt: "Illustration of one combined browser run replacing separate slow round-trips",
    flip: true,
  },
];

export const ISOLATION_HIGHLIGHTS = [
  {
    title: "Named tab groups",
    body: "Agent tabs sit together under one colored Chrome tab label.",
  },
  {
    title: "Personal tabs untouched",
    body: "Your open work stays completely separate and is never closed.",
  },
  {
    title: "Safe login handoff",
    body: "When a sign-in or CAPTCHA appears, it pauses and hands control to you.",
  },
];

export const BEFORE_AFTER_STEPS: BeforeAfterStep[] = [
  {
    id: "usual-way",
    title: "The usual way",
    summary: "Generic browser tools spin up a heavy blank browser that logs you out and dumps raw page code every step.",
    chipLabel: "Before",
  },
  {
    id: "real-chrome",
    title: "Your real Chrome",
    summary: "Connects straight to your open Chrome with logins kept ready inside a clean colored Tab Group.",
    chipLabel: "Step 1 of 3",
  },
  {
    id: "clean-outline",
    title: "Clean page outline",
    summary: "Reads only interactive controls like buttons and inputs, skipping visual clutter and cutting tokens in half.",
    chipLabel: "Step 2 of 3",
  },
  {
    id: "one-fast-run",
    title: "One fast run",
    summary: "Finishes multi-page checks, saves results to disk and cleans up its temporary tabs in a single pass.",
    chipLabel: "Step 3 of 3",
  },
];

export const KEY_NUMBERS: KeyNumberItem[] = [
  {
    id: "speed",
    value: "3.8x",
    label: "Faster browser actions",
    detail: "Measured on the same AI model completing a real multi-page Chrome workflow.",
  },
  {
    id: "tokens",
    value: "52%",
    label: "Fewer tokens used",
    detail: "Compact page outlines replace bulky HTML dumps and oversized screenshots.",
  },
  {
    id: "local",
    value: "100%",
    label: "Local and free",
    detail: "Runs entirely on your machine under the MIT license with zero cloud fees.",
  },
];

export const INSTALL_METHODS: InstallMethod[] = [
  {
    id: "antigravity",
    label: "Antigravity",
    command: "node mcp-server/bin/browser-use.js install --client antigravity --write --skill",
    noteBefore: "Copies Chrome extension ",
    noteCode: "v0.6.4",
    noteAfter: ", sets up Antigravity automatically with a backup, and installs the agent skill.",
  },
  {
    id: "claude",
    label: "Claude Code",
    command: "node mcp-server/bin/browser-use.js install --client claude_code --write --skill --profile auto",
    noteBefore: "Configures ",
    noteCode: "Claude Code",
    noteAfter: " with compact tool defaults and installs the skill bundle cleanly.",
  },
  {
    id: "codex",
    label: "Codex",
    command: "node mcp-server/bin/browser-use.js config --client codex --profile auto",
    noteBefore: "Prints the Codex configuration block. Run ",
    noteCode: "install --client codex --skill",
    noteAfter: " alongside it to copy the extension.",
  },
  {
    id: "cursor",
    label: "Cursor",
    command: "node mcp-server/bin/browser-use.js install --client cursor --write --skill",
    noteBefore: "Writes the local bridge entry to ",
    noteCode: "~/.cursor/mcp.json",
    noteAfter: " and installs the Cursor browser rule.",
  },
  {
    id: "commandcode",
    label: "Command Code",
    command: "node mcp-server/bin/browser-use.js install --client commandcode --write --skill --profile auto",
    noteBefore: "Configures ",
    noteCode: "Command Code",
    noteAfter: " automatically in lightweight compact mode.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: "node mcp-server/bin/browser-use.js config --client opencode --profile auto",
    noteBefore: "Prints the local setup JSON for ",
    noteCode: "OpenCode",
    noteAfter: " with compact tools ready out of the box.",
  },
];

export const FAQ_ITEMS: FaqItem[] = [
  {
    question: "Which coding agents work with this?",
    answer:
      "Any agent with local MCP support: Antigravity, Claude Code, Codex, Cursor, Windsurf, GitHub Copilot, Command Code and OpenCode.",
  },
  {
    question: "Can the agent touch my personal tabs?",
    answer:
      "No. It opens fresh tabs inside its own labeled Chrome Tab Group and leaves all of your open tabs untouched.",
  },
  {
    question: "Why not just use Playwright?",
    answer:
      "Playwright launches a separate blank browser with none of your logins. This connects directly to your real Chrome and uses roughly half as many tokens.",
  },
  {
    question: "What happens on login screens or CAPTCHAs?",
    answer:
      "It never tries to bypass security checks. It pauses cleanly so you can sign in yourself, then picks right back up.",
  },
  {
    question: "Does it cost anything or send data to a server?",
    answer:
      "Nothing leaves your computer. It is free, MIT open-source software running locally on Node.js and Chrome.",
  },
  {
    question: "How do I connect Chrome after installing?",
    answer:
      "Open chrome://extensions, enable Developer mode, click Load unpacked, and select ~/.local/share/browser-use/extension.",
  },
];
