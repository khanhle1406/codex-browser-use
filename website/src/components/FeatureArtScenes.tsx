import { useEffect, useState } from "react";
import { Check, CheckCircle, CursorClick, HandPalm, ShieldCheck, TrendUp } from "@phosphor-icons/react";
import { notifyManualIsolationPick, useCursorChoreography } from "../lib/cursorDirector";
import { AgentCursor } from "./AgentCursor";
import { ChromeWindow } from "./ChromeWindow";

export function RealChromeFeatureArt() {
  const { enabled: roaming, feat1Step } = useCursorChoreography();
  const profileHit = roaming && feat1Step === "profile";
  const deployHit = roaming && feat1Step === "deploy";

  return (
    <div className="feat-float">
      <ChromeWindow
        variant="dark"
        compact
        loading={deployHit}
        extensionStatus="connected"
        profileLabel="M"
        profileTargetId="feat1-profile"
        profilePopover={profileHit}
        personalTabs={[{ title: "Gmail", icon: "gmail" }]}
        tabGroups={[
          {
            label: "Local",
            color: deployHit ? "green" : "blue",
            tabs: [
              {
                title: "Deploy preview",
                icon: "deploy",
                active: true,
                badge: deployHit ? "deliverable" : "active",
              },
            ],
          },
        ]}
        url={{ protocol: "http://", host: "localhost:3000", path: "/deployments" }}
      >
        <div
          data-step-hit={profileHit || deployHit ? "true" : undefined}
          className="p-3.5 sm:p-4 bg-[#14171f] text-white relative overflow-hidden flex flex-col justify-between gap-2.5 flex-1"
        >
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex items-center gap-1.5">
              <span className="mono text-[10px] font-semibold px-2 py-0.5 rounded bg-white/[0.08] border border-white/12 text-white/90">
                feat/checkout-v2
              </span>
              <span className="mono text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-white/55">
                8f3a1c
              </span>
            </div>
            <span
              className={`mono text-[10px] px-2 py-0.5 rounded-full transition-colors duration-200 ${
                profileHit
                  ? "bg-[#1a73e8]/25 text-[#8ab4f8] border border-[#8ab4f8]/45"
                  : "text-white/65"
              }`}
            >
              minh@kestrel.io
            </span>
          </div>

          <div
            data-step-hit={deployHit ? "true" : undefined}
            className={`relative rounded-xl border p-3 overflow-hidden flex flex-col gap-2.5 transition-all duration-300 ${
              deployHit
                ? "bg-emerald-500/12 border-emerald-400/50"
                : "bg-white/[0.05] border-white/12"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-white truncate">
                  {deployHit ? "Live on staging.kestrel.io" : "Local build ready on :3000"}
                </div>
                <div className="text-[10.5px] text-white/60 truncate mt-0.5">
                  Uses your signed-in Chrome OAuth session
                </div>
              </div>

              <button
                type="button"
                tabIndex={-1}
                data-cursor-target="feat1-deploy"
                data-cursor-anchor="0.5,0.5"
                className={`text-[10.5px] font-semibold px-2.5 py-1 rounded-md text-white shrink-0 inline-flex items-center gap-1 border-0 transition-all duration-200 ${
                  deployHit
                    ? "bg-emerald-600 ring-2 ring-emerald-300/60 scale-[0.98]"
                    : "bg-[#1a73e8]"
                }`}
              >
                {deployHit && <Check size={11} weight="bold" aria-hidden="true" />}
                <span>{deployHit ? "Live" : "Promote to staging"}</span>
              </button>
            </div>

            <div className="cbu-deploy-track" aria-hidden="true">
              <span className="cbu-deploy-bar" style={{ width: deployHit ? "100%" : "18%" }} />
            </div>

            {!roaming && <AgentCursor className="cbu-cursor-feat-1" label="" showRipple={false} />}
          </div>

          <div className="pt-2 border-t border-white/10 flex items-center justify-between text-[10.5px] text-white/55">
            <span>React DevTools &amp; cookies active</span>
            <span className={deployHit ? "text-emerald-300 font-medium" : "text-white/65"}>
              {deployHit ? "1.4s · Reused existing login" : "Ready in open tab"}
            </span>
          </div>
        </div>
      </ChromeWindow>
    </div>
  );
}

export function OneRunFeatureArt() {
  const { enabled: roaming, feat2Step } = useCursorChoreography();
  const step1Hit = roaming && (feat2Step === "step1" || feat2Step === "export" || feat2Step === "saved");
  const exportHit = roaming && feat2Step === "export";
  const savedHit = roaming && feat2Step === "saved";

  const lines = [
    {
      step: "1",
      text: "Open /invoices",
      badge: !roaming || step1Hit ? "Done" : "Next",
      active: roaming && feat2Step === "step1",
      done: !roaming || step1Hit,
    },
    {
      step: "2",
      text: "Click Export CSV",
      badge: savedHit || !roaming ? "Done" : exportHit ? "Running" : "Queued",
      active: roaming && feat2Step === "export",
      done: !roaming || savedHit,
    },
    {
      step: "3",
      text: "Save orders.json",
      badge: savedHit || !roaming ? "Saved" : "Queued",
      active: roaming && feat2Step === "saved",
      done: !roaming || savedHit,
    },
  ];

  const invoiceRows = [
    { id: "#4821", customer: "Halcyon", amt: "$1,248" },
    { id: "#4822", customer: "Vektor", amt: "$2,140" },
  ];

  return (
    <div className="feat-float">
      <ChromeWindow
        variant="light"
        compact
        loading={exportHit}
        extensionStatus="connected"
        profileLabel="M"
        tabGroups={[
          {
            label: "browser_run",
            color: savedHit ? "green" : "blue",
            tabs: [
              {
                title: "Invoices · Kestrel",
                icon: "orders",
                active: true,
                badge: savedHit ? "deliverable" : "active",
              },
            ],
          },
        ]}
        url={{ protocol: "https://", host: "staging.kestrel.io", path: "/invoices" }}
        downloadBadge={{ filename: "orders.json · 18.4 KB", active: savedHit }}
        downloadHighlight={savedHit}
      >
        <div className="grid grid-cols-1 sm:grid-cols-12 bg-white text-[#0b1220] flex-1">
          {/* Compact Execution Sequence */}
          <div className="sm:col-span-5 bg-[#f8fafc] border-b sm:border-b-0 sm:border-r border-[#090e1a]/8 p-2.5 space-y-1.5">
            {lines.map((item, idx) => (
              <div
                key={item.step}
                data-cursor-target={idx === 0 ? "feat2-step1" : undefined}
                data-cursor-anchor="0.82,0.5"
                data-step-hit={item.active ? "true" : undefined}
                className={`${roaming ? "" : "cbu-one-run-line"} rounded-lg px-2 py-1.5 border flex items-center justify-between gap-1.5 text-[10.5px] transition-all duration-200 ${
                  item.active ? "border-[#1a73e8] bg-[#e8f0fe]" : "border-[#090e1a]/8 bg-white"
                }`}
                style={!roaming ? { animationDelay: `${idx * 0.9}s` } : undefined}
              >
                <span className="truncate font-medium text-[#0b1220]/90">
                  {item.step}. {item.text}
                </span>
                <span
                  className={`text-[9.5px] font-semibold shrink-0 ${
                    item.done ? "text-emerald-700" : item.active ? "text-[#1a73e8]" : "text-[#0b1220]/45"
                  }`}
                >
                  {item.badge}
                </span>
              </div>
            ))}
          </div>

          {/* Mini Realistic Invoices Table + Action */}
          <div className="sm:col-span-7 p-2.5 flex flex-col justify-between gap-1.5 bg-white">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10.5px] font-semibold text-[#0b1220]">Invoices (48)</span>
              <button
                type="button"
                tabIndex={-1}
                data-cursor-target="feat2-export"
                data-cursor-anchor="0.5,0.5"
                data-step-hit={exportHit ? "true" : undefined}
                className={`rounded-md border px-2 py-1 inline-flex items-center gap-1 text-[10px] font-semibold transition-all duration-200 ${
                  savedHit
                    ? "bg-emerald-50 border-emerald-400 text-emerald-800"
                    : exportHit
                      ? "bg-[#e8f0fe] border-[#1a73e8] text-[#1a73e8] shadow-[0_0_0_2px_rgba(26,115,232,0.18)]"
                      : "bg-[#f8fafc] border-[#090e1a]/12 text-[#0b1220]"
                }`}
              >
                {savedHit ? (
                  <Check size={11} weight="bold" className="text-emerald-700" aria-hidden="true" />
                ) : (
                  <CursorClick size={11} weight="bold" className="text-[#1a73e8]" aria-hidden="true" />
                )}
                <span>{savedHit ? "Exported CSV" : "Export CSV"}</span>
              </button>
            </div>

            <div
              tabIndex={0}
              role="region"
              aria-label="Staging invoices preview"
              className="rounded-lg border border-[#090e1a]/8 overflow-x-auto"
            >
              <table className="w-full text-left border-collapse text-[10px] tabular-nums">
                <thead>
                  <tr className="bg-[#f8fafc] border-b border-[#090e1a]/6 text-[#0b1220]/50">
                    <th scope="col" className="py-1 px-2 font-medium">
                      Invoice
                    </th>
                    <th scope="col" className="py-1 px-2 font-medium">
                      Account
                    </th>
                    <th scope="col" className="py-1 px-2 font-medium text-right">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#090e1a]/5">
                  {invoiceRows.map((row) => (
                    <tr key={row.id} className="text-[#0b1220]/85">
                      <td className="py-1 px-2 mono text-[#0b1220]/60">{row.id}</td>
                      <td className="py-1 px-2 font-medium">{row.customer}</td>
                      <td className="py-1 px-2 text-right font-semibold mono">{row.amt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div
              data-cursor-target="feat2-saved"
              data-cursor-anchor="0.72,0.5"
              className={`cbu-saved-pill inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-semibold transition-all duration-300 ${
                savedHit ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-300/70" : "text-[#0b1220]/60"
              }`}
            >
              <CheckCircle size={12} weight="fill" className={savedHit ? "text-emerald-600" : "text-emerald-600/60"} aria-hidden="true" />
              <span>orders.json saved (18.4 KB)</span>
            </div>
          </div>
        </div>
      </ChromeWindow>
    </div>
  );
}

type IsolationStateId = "working" | "deliverable" | "handoff";

const ISOLATION_STATES: Array<{
  id: IsolationStateId;
  label: string;
  groupName: string;
  tabTitle: string;
  tabIcon: "checkout" | "report" | "lock";
  groupColor: "blue" | "green" | "amber";
  dotColor: string;
  urlHost: string;
  urlPath: string;
  badgeText: string;
}> = [
  {
    id: "working",
    label: "Working tab",
    groupName: "Agent QA",
    tabTitle: "Checkout QA",
    tabIcon: "checkout",
    groupColor: "blue",
    dotColor: "#1a73e8",
    urlHost: "app.kestrel.io",
    urlPath: "/checkout",
    badgeText: "Blue · Agent working",
  },
  {
    id: "deliverable",
    label: "Kept result",
    groupName: "Summary",
    tabTitle: "Q4 Revenue",
    tabIcon: "report",
    groupColor: "green",
    dotColor: "#188038",
    urlHost: "app.kestrel.io",
    urlPath: "/reports/q4",
    badgeText: "Green · Kept result",
  },
  {
    id: "handoff",
    label: "Login handoff",
    groupName: "Sign In",
    tabTitle: "2-Step Verify",
    tabIcon: "lock",
    groupColor: "amber",
    dotColor: "#f59e0b",
    urlHost: "accounts.kestrel.io",
    urlPath: "/signin/2fa",
    badgeText: "Amber · Paused for user",
  },
];

export function TabIsolationSimulator() {
  const { enabled: roaming, isolationStep } = useCursorChoreography();
  const [selectedId, setSelectedId] = useState<IsolationStateId>("working");
  const [userPicked, setUserPicked] = useState(false);

  useEffect(() => {
    if (roaming || userPicked) return undefined;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return undefined;
    }

    const idList: IsolationStateId[] = ["working", "deliverable", "handoff"];
    const timer = window.setInterval(() => {
      setSelectedId((prev) => {
        const nextIdx = (idList.indexOf(prev) + 1) % idList.length;
        return idList[nextIdx];
      });
    }, 4200);

    return () => window.clearInterval(timer);
  }, [roaming, userPicked]);

  const effectiveId: IsolationStateId = roaming && !userPicked ? isolationStep : selectedId;
  const current = ISOLATION_STATES.find((s) => s.id === effectiveId) ?? ISOLATION_STATES[0];

  const renderSwitcherPills = (attachTargets: boolean) => (
    <div
      className="flex items-center gap-1 rounded-full bg-black/25 p-0.5 shrink-0"
      role="group"
      aria-label="Preview tab states"
    >
      {ISOLATION_STATES.map((item) => {
        const active = item.id === current.id;
        return (
          <button
            key={item.id}
            type="button"
            data-cursor-target={attachTargets ? `iso-${item.id}` : undefined}
            data-cursor-anchor={attachTargets ? "0.5,0.6" : undefined}
            onClick={() => {
              setUserPicked(true);
              notifyManualIsolationPick(true);
              setSelectedId(item.id);
            }}
            aria-pressed={active}
            className={`px-2 py-0.5 rounded-full text-[10.5px] font-medium transition-colors cursor-pointer border-0 whitespace-nowrap ${
              active ? "bg-[#1a73e8] text-white" : "bg-transparent text-white/70 hover:text-white"
            }`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );

  const revenueBars = [
    { label: "Q1", h: "42%", cls: "bg-[#1a73e8]/35" },
    { label: "Q2", h: "60%", cls: "bg-[#1a73e8]/55" },
    { label: "Q3", h: "76%", cls: "bg-[#1a73e8]/80" },
    { label: "Q4", h: "100%", cls: "bg-emerald-600" },
  ];

  return (
    <div className="relative rounded-[20px] overflow-hidden">
      {/* Calm parking spot in outer corner when cursor backs away from 2FA login prompt */}
      <span
        data-cursor-target="iso-retreat"
        data-cursor-anchor="0.5,0.5"
        className="absolute right-8 bottom-6 w-2 h-2 pointer-events-none z-10"
        aria-hidden="true"
      />

      <ChromeWindow
        variant="dark"
        extensionStatus={current.id === "handoff" ? "paused" : "connected"}
        profileLabel="M"
        personalTabs={[
          { title: "Gmail (4)", icon: "gmail" },
          { title: "Q4 Spec", icon: "docs" },
          { title: "Standup", icon: "calendar" },
        ]}
        tabGroups={[
          {
            label: current.groupName,
            color: current.groupColor,
            tabs: [
              {
                title: current.tabTitle,
                icon: current.tabIcon,
                active: true,
                badge:
                  current.id === "deliverable"
                    ? "deliverable"
                    : current.id === "handoff"
                      ? "handoff"
                      : "active",
              },
            ],
          },
        ]}
        url={{ protocol: "https://", host: current.urlHost, path: current.urlPath }}
        toolbarRightSlot={<div className="hidden md:flex">{renderSwitcherPills(true)}</div>}
        subToolbarSlot={
          <div className="flex md:hidden items-center justify-between px-3 py-1.5 bg-[#202124] border-b border-white/10">
            <span className="text-[10.5px] text-white/60">Preview state:</span>
            {renderSwitcherPills(false)}
          </div>
        }
      >
        <div className="p-4 sm:p-5 grid grid-cols-1 md:grid-cols-12 gap-4 items-stretch bg-[#14171f] text-white flex-1">
          {/* Session Guard Panel */}
          <div className="md:col-span-4 rounded-xl bg-white/[0.04] border border-white/10 p-3.5 flex flex-col justify-between gap-3">
            <div>
              <div className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-emerald-300">
                <ShieldCheck size={15} weight="duotone" aria-hidden="true" />
                <span>Session Guard</span>
              </div>
              <div className="mt-2.5 space-y-1.5 text-[11.5px] text-white/75">
                {[
                  { name: "Gmail · 4 unread", status: "Untouched" },
                  { name: "Q4 Spec · Docs", status: "Untouched" },
                  { name: "Standup · Calendar", status: "Untouched" },
                ].map((tab) => (
                  <div
                    key={tab.name}
                    className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-white/[0.04]"
                  >
                    <span className="truncate">{tab.name}</span>
                    <span className="text-emerald-300 text-[10px] font-medium shrink-0">
                      {tab.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="pt-2 border-t border-white/10 flex items-center gap-2 text-[11px] font-medium text-white/85">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: current.dotColor }}
              />
              <span className="truncate">{current.badgeText}</span>
            </div>
          </div>

          {/* Real Production Page Viewport */}
          <div
            data-cursor-target="iso-viewport"
            data-cursor-anchor="0.82,0.58"
            className="md:col-span-8 rounded-xl bg-white text-[#0b1220] p-4 sm:p-5 relative overflow-hidden shadow-lg flex flex-col justify-between gap-3"
          >
            {current.id === "working" && (
              <>
                <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-[#090e1a]/8">
                  <div>
                    <h3 className="text-[15px] font-semibold tracking-tight text-[#0b1220] m-0">
                      Checkout QA
                    </h3>
                    <p className="text-[11px] text-[#0b1220]/55 mt-0.5 mb-0">
                      Sandbox subscription verification · app.kestrel.io
                    </p>
                  </div>
                  <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full bg-[#e8f0fe] text-[#1a73e8]">
                    Agent QA Tab
                  </span>
                </div>

                <div className="rounded-xl bg-[#f8fafc] border border-[#090e1a]/10 p-3 space-y-2 text-[12px]">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-[#0b1220]">Pro Annual · 4 seats</span>
                    <span className="mono font-semibold text-[#0b1220] tabular-nums">$1,881.60</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="inline-flex items-center gap-1.5 text-[#0b1220]/65">
                      <span>Promo code</span>
                      <span className="mono px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-semibold">
                        LAUNCH20
                      </span>
                    </span>
                    <span className="text-emerald-700 font-semibold tabular-nums">-20% applied</span>
                  </div>
                </div>

                <div className="pt-2 border-t border-[#090e1a]/8 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] text-[#0b1220]/60">Agent testing inside Blue group</span>
                  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1a73e8] text-white text-[11.5px] font-semibold">
                    <CursorClick size={13} weight="bold" aria-hidden="true" />
                    <span>Run test checkout</span>
                  </span>
                </div>
              </>
            )}

            {current.id === "deliverable" && (
              <>
                <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-[#090e1a]/8">
                  <div>
                    <h3 className="text-[15px] font-semibold tracking-tight text-[#0b1220] m-0">
                      Q4 Revenue Report
                    </h3>
                    <p className="text-[11px] text-[#0b1220]/55 mt-0.5 mb-0">
                      Reconciled fiscal summary · Ready for review
                    </p>
                  </div>
                  <CheckCircle size={18} weight="fill" className="text-emerald-600" aria-hidden="true" />
                </div>

                <div className="grid grid-cols-3 gap-2 tabular-nums">
                  <div className="rounded-lg bg-[#f8fafc] border border-[#090e1a]/8 px-2.5 py-2">
                    <div className="text-[10px] text-[#0b1220]/55">Q4 Revenue</div>
                    <div className="text-[14px] font-semibold text-[#0b1220] mt-0.5">$142,800</div>
                  </div>
                  <div className="rounded-lg bg-emerald-50/70 border border-emerald-200 px-2.5 py-2">
                    <div className="text-[10px] text-emerald-800/75">YoY Growth</div>
                    <div className="text-[14px] font-semibold text-emerald-700 mt-0.5 inline-flex items-center gap-1">
                      <TrendUp size={13} weight="bold" aria-hidden="true" />
                      <span>+34.2%</span>
                    </div>
                  </div>
                  <div className="rounded-lg bg-[#f8fafc] border border-[#090e1a]/8 px-2.5 py-2">
                    <div className="text-[10px] text-[#0b1220]/55">Settled Orders</div>
                    <div className="text-[14px] font-semibold text-[#0b1220] mt-0.5">418</div>
                  </div>
                </div>

                <div className="pt-2 border-t border-[#090e1a]/10 flex items-end justify-between gap-3">
                  <div className="flex items-end gap-2" aria-hidden="true">
                    {revenueBars.map((bar) => (
                      <div key={bar.label} className="flex flex-col items-center gap-0.5">
                        <div className="h-7 flex items-end">
                          <span className={`w-4 rounded-t-[4px] ${bar.cls}`} style={{ height: bar.h }} />
                        </div>
                        <span className="mono text-[9.5px] text-[#0b1220]/60">{bar.label}</span>
                      </div>
                    ))}
                  </div>
                  <span className="text-[11px] font-medium text-emerald-700">
                    Kept open for your review · 2 temp tabs closed
                  </span>
                </div>
              </>
            )}

            {current.id === "handoff" && (
              <>
                <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-[#090e1a]/8">
                  <div>
                    <h3 className="text-[15px] font-semibold tracking-tight text-[#0b1220] m-0">
                      Verify your identity
                    </h3>
                    <p className="text-[11px] text-[#0b1220]/60 mt-0.5 mb-0">
                      Enter the 6-digit code sent to •••• 1928
                    </p>
                  </div>
                  <HandPalm size={18} weight="duotone" className="text-amber-600" aria-hidden="true" />
                </div>

                <div className="py-1 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5" aria-hidden="true">
                    {["4", "8", "2", "1", "", ""].map((ch, idx) => (
                      <span
                        key={idx}
                        className={`w-7 h-8 rounded-md grid place-items-center text-[13px] font-semibold mono text-[#0b1220] border ${
                          idx === 4
                            ? "cbu-otp-active border-amber-500 bg-amber-50"
                            : "border-[#090e1a]/20 bg-[#f8fafc]"
                        }`}
                      >
                        {idx === 4 ? <span className="cbu-caret" /> : ch}
                      </span>
                    ))}
                  </div>
                  <span className="px-2.5 py-1 rounded-md bg-amber-100 text-amber-900 border border-amber-300 text-[11px] font-semibold">
                    2FA Checkpoint
                  </span>
                </div>

                <div className="pt-2 border-t border-amber-200/80 flex items-center justify-between gap-2 text-[11px] text-amber-900 font-medium">
                  <span>Agent paused automatically · Waiting for you</span>
                  <span className="mono text-[10px] px-2 py-0.5 rounded bg-amber-100">Handoff</span>
                </div>
              </>
            )}

            {!roaming && current.id === "working" && (
              <AgentCursor className="cbu-cursor-isolation" label="Agent" showRipple />
            )}
          </div>
        </div>
      </ChromeWindow>
    </div>
  );
}
