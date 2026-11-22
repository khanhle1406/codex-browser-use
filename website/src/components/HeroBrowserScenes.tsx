import {
  Check,
  CheckCircle,
  CircleNotch,
  Clock,
  Cpu,
  Globe,
  LockSimple,
  PlugsConnected,
  ShieldCheck,
  TerminalWindow,
  TrendUp,
} from "@phosphor-icons/react";
import { useCursorChoreography } from "../lib/cursorDirector";
import { AgentCursor } from "./AgentCursor";
import { ChromeWindow } from "./ChromeWindow";

interface HeroBrowserSceneProps {
  id: string;
  active: boolean;
}

function LiveChromeStage({ active }: { active: boolean }) {
  const { enabled: roaming, heroStep } = useCursorChoreography();
  const hit12 = roaming && heroStep === "focus-12";
  const toggleOn = roaming ? heroStep === "toggle-14" || heroStep === "confirm-19" : true;
  const hit14 = roaming && heroStep === "toggle-14";
  const confirmOn = roaming && heroStep === "confirm-19";
  const emailVerified = roaming ? hit12 || toggleOn || confirmOn : true;

  const taskStatus = confirmOn
    ? "Step 3/3 · Annual plan active"
    : hit14
      ? "Step 2/3 · Enabling annual (-20%)"
      : hit12
        ? "Step 1/3 · Verifying invoice email"
        : "Task: Switch plan to annual";

  return (
    <div
      className={`work-stage ${active && !roaming ? "cbu-anim-on" : ""}`}
      data-roaming-driven={roaming ? "true" : undefined}
    >
      <ChromeWindow
        variant="light"
        showBookmarks
        loading={confirmOn}
        extensionStatus="connected"
        profileLabel="M"
        personalTabs={[
          { title: "Inbox (4) - Gmail", icon: "gmail" },
          { title: "Sprint 14 - Linear", icon: "linear" },
        ]}
        tabGroups={[
          {
            label: "Billing QA",
            color: confirmOn ? "green" : "blue",
            tabs: [
              {
                title: "Billing - Kestrel",
                icon: "acme",
                active: true,
                badge: confirmOn ? "deliverable" : "active",
              },
            ],
          },
        ]}
        url={{ protocol: "https://", host: "app.kestrel.io", path: "/billing" }}
      >
        {/* Real Kestrel Cloud SaaS Billing Workspace */}
        <div className="relative flex flex-1 min-h-0 bg-white text-[#0b1220]">
          {/* App Navigation Rail */}
          <aside className="hidden sm:flex w-[166px] shrink-0 flex-col justify-between bg-[#f8fafc] border-r border-[#090e1a]/8 p-3.5 select-none">
            <div>
              <div className="flex items-center gap-2 px-1.5 py-1">
                <span className="w-6 h-6 rounded-md bg-[#2563eb] text-white font-bold text-[11px] grid place-items-center">
                  K
                </span>
                <span className="text-[12.5px] font-semibold tracking-tight text-[#0b1220]">
                  Kestrel Cloud
                </span>
              </div>

              <nav className="mt-3 space-y-0.5 text-[11.5px]" aria-hidden="true">
                {["Overview", "Projects", "Usage"].map((item) => (
                  <div key={item} className="px-2.5 py-1.5 rounded-md text-[#0b1220]/60">
                    {item}
                  </div>
                ))}
                <div className="px-2.5 py-1.5 rounded-md bg-[#e8f0fe] text-[#1a73e8] font-semibold">
                  Billing
                </div>
                <div className="px-2.5 py-1.5 rounded-md text-[#0b1220]/60">API Keys</div>
              </nav>
            </div>

            <div className="px-2.5 py-2 rounded-lg bg-white border border-[#090e1a]/8 text-[10.5px]">
              <div className="flex items-center gap-1.5 text-emerald-700 font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 cbu-live-dot" />
                <span>Minh Tran</span>
              </div>
              <div className="text-[#0b1220]/60 truncate mt-0.5">minh@kestrel.io</div>
            </div>
          </aside>

          {/* Main Subscription Settings Page */}
          <div className="hc-card cbu-live-card relative flex-1 min-w-0 p-3.5 sm:p-5 flex flex-col justify-between gap-2.5">
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-[#090e1a]/8">
                <div>
                  <h3 className="text-[15px] sm:text-[16px] font-semibold tracking-tight text-[#0b1220] m-0">
                    Billing &amp; Subscription
                  </h3>
                  <p className="text-[11px] text-[#0b1220]/55 mt-0.5 mb-0">
                    Pro Team · 4 seats · Visa ending 4242
                  </p>
                </div>
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10.5px] font-medium transition-colors duration-200 ${
                    confirmOn
                      ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                      : "bg-[#f1f5f9] border-[#090e1a]/10 text-[#0b1220]/80"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      confirmOn ? "bg-emerald-500" : "bg-[#1a73e8]"
                    }`}
                  />
                  <span>{taskStatus}</span>
                </span>
              </div>

              {/* Interactive Form Controls */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mt-3">
                <div
                  data-cursor-target={active ? "hero-12" : undefined}
                  data-cursor-anchor="0.86,0.55"
                  data-step-hit={hit12 ? "true" : undefined}
                  className={`cbu-target-12 rounded-xl border px-3 py-2 flex flex-col justify-between gap-1 transition-all duration-200 ${
                    hit12
                      ? "border-[#1a73e8] bg-[#f8fbff] ring-2 ring-[#1a73e8]/15"
                      : "border-[#090e1a]/10 bg-[#f8fafc]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10.5px] font-medium text-[#0b1220]/60">Invoice email</span>
                    {emailVerified && (
                      <span className="inline-flex items-center gap-1 text-[9.5px] font-semibold px-1.5 py-[1px] rounded bg-emerald-100 text-emerald-800">
                        <Check size={9} weight="bold" aria-hidden="true" />
                        <span>Verified</span>
                      </span>
                    )}
                  </div>
                  <div className="rounded-lg border border-[#090e1a]/12 bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#0b1220] flex items-center justify-between">
                    <span className="truncate flex items-center">
                      <span>billing@kestrel.io</span>
                      {hit12 && <span className="cbu-caret" aria-hidden="true" />}
                    </span>
                  </div>
                </div>

                <div
                  data-cursor-target={active ? "hero-14" : undefined}
                  data-cursor-anchor="0.86,0.55"
                  data-step-hit={hit14 ? "true" : undefined}
                  className={`cbu-target-14 rounded-xl border px-3 py-2 flex items-center justify-between gap-2 transition-all duration-200 ${
                    hit14
                      ? "border-[#1a73e8] bg-[#f8fbff] ring-2 ring-[#1a73e8]/15"
                      : "border-[#090e1a]/10 bg-[#f8fafc]"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10.5px] font-medium text-[#0b1220]/60">
                        Annual billing · Save 20%
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="text-[12.5px] font-semibold text-[#0b1220] tabular-nums">
                        {toggleOn ? "$156.80/mo" : "$196.00/mo"}
                      </span>
                      {toggleOn && (
                        <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 tabular-nums">
                          Save $470.40/yr
                        </span>
                      )}
                    </div>
                  </div>
                  <span
                    data-toggle-on={toggleOn ? "true" : "false"}
                    className="cbu-toggle-track w-9 h-5 rounded-full p-0.5 inline-flex items-center shrink-0"
                  >
                    <span className="cbu-toggle-thumb w-4 h-4 rounded-full bg-white shadow-sm" />
                  </span>
                </div>
              </div>

              {/* Compact Real Recent Invoices Semantic Table */}
              <div
                tabIndex={0}
                role="region"
                aria-label="Recent invoices"
                className="mt-2.5 rounded-xl border border-[#090e1a]/10 bg-white overflow-x-auto"
              >
                <table className="w-full text-left border-collapse text-[11px] tabular-nums">
                  <thead>
                    <tr className="bg-[#f8fafc] border-b border-[#090e1a]/8 text-[#0b1220]/55 text-[10px]">
                      <th scope="col" className="py-1.5 px-3 font-medium">
                        Invoice
                      </th>
                      <th scope="col" className="py-1.5 px-2.5 font-medium">
                        Date
                      </th>
                      <th scope="col" className="py-1.5 px-2.5 font-medium text-right">
                        Amount
                      </th>
                      <th scope="col" className="py-1.5 px-3 font-medium text-right">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#090e1a]/6">
                    <tr>
                      <td className="py-1.5 px-3 font-medium text-[#0b1220] mono">INV-8841</td>
                      <td className="py-1.5 px-2.5 text-[#0b1220]/65">Oct 14, 2026</td>
                      <td className="py-1.5 px-2.5 text-right font-medium text-[#0b1220]">$196.00</td>
                      <td className="py-1.5 px-3 text-right">
                        <span className="text-[10px] font-semibold text-emerald-700">Paid</span>
                      </td>
                    </tr>
                    <tr className="hidden sm:table-row">
                      <td className="py-1.5 px-3 font-medium text-[#0b1220] mono">INV-8812</td>
                      <td className="py-1.5 px-2.5 text-[#0b1220]/65">Sep 14, 2026</td>
                      <td className="py-1.5 px-2.5 text-right font-medium text-[#0b1220]">$196.00</td>
                      <td className="py-1.5 px-3 text-right">
                        <span className="text-[10px] font-semibold text-emerald-700">Paid</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
                {toggleOn && (
                  <div className="px-3 py-1.5 bg-[#eff6ff] border-t border-[#1a73e8]/15 flex items-center justify-between text-[10.5px] text-[#1e40af] tabular-nums">
                    <span className="font-medium">Next renewal · Annual plan</span>
                    <span className="font-semibold">$1,881.60/yr (-20%)</span>
                  </div>
                )}
              </div>
            </div>

            <div className="pt-2 border-t border-[#090e1a]/8 flex flex-wrap items-center justify-between gap-2">
              <div
                data-toast-open={confirmOn ? "true" : "false"}
                className="cbu-toast-pop inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#0b1220] text-white text-[11px] font-medium shadow-md"
              >
                <Check size={12} weight="bold" className="text-emerald-400" aria-hidden="true" />
                <span>Annual billing saved · $470.40/yr off</span>
              </div>

              <div
                data-cursor-target={active ? "hero-19" : undefined}
                data-cursor-anchor="0.5,0.5"
                data-step-hit={confirmOn ? "true" : undefined}
                className={`cbu-target-19 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-white text-[12px] font-semibold shadow-sm transition-all duration-200 ml-auto ${
                  confirmOn ? "bg-emerald-600 ring-2 ring-emerald-300/60" : "bg-[#1a73e8]"
                }`}
              >
                {confirmOn && <Check size={12} weight="bold" aria-hidden="true" />}
                <span>{confirmOn ? "Plan updated" : "Confirm annual plan"}</span>
              </div>
            </div>

            {!roaming && (
              <div className="cbu-cursor-stage" aria-hidden="true">
                <AgentCursor
                  className="cbu-cursor-hero"
                  label="Agent"
                  rippleClassName="cbu-cursor-ripple cbu-ripple-hero"
                />
              </div>
            )}
          </div>

          <span className="chrome-mac-scroll" aria-hidden="true" />
        </div>
      </ChromeWindow>
    </div>
  );
}

function TabGroupsStage({ active }: { active: boolean }) {
  const { enabled: roaming, heroTabPhase } = useCursorChoreography();
  const isGreen = roaming && heroTabPhase === "green";

  const orderRows = [
    { id: "#4821", customer: "Halcyon Audio", total: "$1,248.50", status: "Verified" },
    { id: "#4822", customer: "Solis Robotics", total: "$892.00", status: "Checked" },
    { id: "#4823", customer: "Vektor Labs", total: "$2,140.00", status: "Auditing" },
    { id: "#4824", customer: "Meridian Bio", total: "$635.40", status: "Queued" },
  ];

  const q4Bars = [
    { q: "Q1", val: "$3,120", h: "52%", cls: "bg-[#3b82f6]/50" },
    { q: "Q2", val: "$3,840", h: "68%", cls: "bg-[#3b82f6]/70" },
    { q: "Q3", val: "$4,210", h: "82%", cls: "bg-[#3b82f6]/85" },
    { q: "Q4", val: "$4,915", h: "100%", cls: "bg-emerald-500" },
  ];

  return (
    <div className={`work-stage ${active && !roaming ? "cbu-anim-on" : ""}`}>
      <ChromeWindow
        variant="dark"
        extensionStatus="connected"
        profileLabel="M"
        personalTabs={[
          { title: "Gmail (4)", icon: "gmail" },
          { title: "Sprint 14", icon: "linear" },
          { title: "Design Spec", icon: "figma" },
        ]}
        tabGroups={[
          {
            label: "Order Audit",
            color: "blue",
            targetId: active ? "hero-tab-blue" : undefined,
            anchor: "0.62,0.55",
            tabs: [{ title: "Orders - Staging", icon: "orders", active: !isGreen, badge: "active" }],
          },
          {
            label: "Deliverable",
            color: "green",
            targetId: active ? "hero-tab-green" : undefined,
            anchor: "0.62,0.55",
            tabs: [{ title: "Q4 Revenue", icon: "report", active: isGreen, badge: "deliverable" }],
          },
        ]}
        url={{
          protocol: "https://",
          host: isGreen ? "app.kestrel.io" : "staging.kestrel.io",
          path: isGreen ? "/reports/q4" : "/orders?status=open",
        }}
      >
        <div className="relative flex-1 min-h-0 p-4 sm:p-5 flex flex-col justify-between gap-3 bg-[#14171f] text-[#f3f6fc]">
          {!isGreen ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-white/10">
                <div>
                  <h3 className="text-[14.5px] font-semibold text-white m-0">Staging Orders Admin</h3>
                  <p className="text-[11px] text-white/55 mt-0.5 mb-0">
                    Open Orders · 4 matched in staging database
                  </p>
                </div>
                <span className="mono text-[10.5px] px-2.5 py-1 rounded-full bg-[#1a73e8]/20 text-[#8ab4f8] border border-[#8ab4f8]/35">
                  status=open
                </span>
              </div>

              <div
                tabIndex={0}
                role="region"
                aria-label="Staging open orders"
                className="rounded-xl bg-[#1b202b] border border-white/10 overflow-x-auto"
              >
                <table className="w-full text-left border-collapse text-[11.5px] tabular-nums">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/[0.03] text-white/55 text-[10.5px]">
                      <th scope="col" className="py-2 px-3.5 font-medium">
                        Order
                      </th>
                      <th scope="col" className="py-2 px-3 font-medium">
                        Customer
                      </th>
                      <th scope="col" className="py-2 px-3 font-medium text-right">
                        Amount
                      </th>
                      <th scope="col" className="py-2 px-3.5 font-medium text-right">
                        Audit
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {orderRows.map((row) => (
                      <tr key={row.id} className="text-white/85">
                        <td className="py-2 px-3.5 mono text-white/60">{row.id}</td>
                        <td className="py-2 px-3 font-medium">{row.customer}</td>
                        <td className="py-2 px-3 text-right mono">{row.total}</td>
                        <td className="py-2 px-3.5 text-right">
                          <span
                            className={`text-[10.5px] font-semibold ${
                              row.status === "Auditing" ? "text-[#8ab4f8]" : "text-emerald-300"
                            }`}
                          >
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="pt-2 border-t border-white/10 flex flex-wrap items-center justify-between gap-2 text-[11px] text-white/65">
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck size={14} weight="fill" className="text-emerald-400" aria-hidden="true" />
                  <span>Blue group: agent working here · Your 3 personal tabs on the left stay untouched</span>
                </span>
                <span className="mono text-[10.5px] text-[#8ab4f8]">Tab Group: Order Audit</span>
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-white/10">
                <div>
                  <h3 className="text-[14.5px] font-semibold text-white m-0">Q4 Revenue Summary</h3>
                  <p className="text-[11px] text-white/55 mt-0.5 mb-0">
                    Reconciled across 4 staging order ledgers
                  </p>
                </div>
                <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-400/35">
                  <CheckCircle size={12} weight="fill" aria-hidden="true" />
                  <span>Verified Deliverable</span>
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2.5 tabular-nums">
                <div className="rounded-xl bg-[#1b202b] border border-white/10 p-3">
                  <div className="text-[10.5px] text-white/55">Verified Total</div>
                  <div className="text-[16px] font-semibold text-white mt-1">$4,915.90</div>
                </div>
                <div className="rounded-xl bg-[#1b202b] border border-white/10 p-3">
                  <div className="text-[10.5px] text-white/55">Matched Orders</div>
                  <div className="text-[16px] font-semibold text-emerald-300 mt-1">4 / 4</div>
                </div>
                <div className="rounded-xl bg-[#1b202b] border border-white/10 p-3">
                  <div className="text-[10.5px] text-white/55">Discrepancies</div>
                  <div className="text-[16px] font-semibold text-white mt-1">0</div>
                </div>
              </div>

              <div className="rounded-xl bg-[#1b202b] border border-white/10 p-3">
                <div className="flex items-center justify-between text-[11px] text-white/70 mb-2">
                  <span className="font-medium">Quarterly Revenue Trend (Q1, Q2, Q3, Q4)</span>
                  <span className="inline-flex items-center gap-1 text-emerald-300 font-semibold">
                    <TrendUp size={13} weight="bold" aria-hidden="true" />
                    <span>+16.7% QoQ</span>
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-2 items-end h-[66px]">
                  {q4Bars.map((bar) => (
                    <div key={bar.q} className="flex flex-col items-center gap-1 h-full justify-end">
                      <span className="mono text-[9.5px] text-white/65 tabular-nums">{bar.val}</span>
                      <div className="w-full h-9 flex items-end">
                        <span className={`w-full rounded-t-md ${bar.cls}`} style={{ height: bar.h }} />
                      </div>
                      <span className="mono text-[10px] text-white/75">{bar.q}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="pt-2 border-t border-white/10 flex flex-wrap items-center justify-between gap-2 text-[11px] text-white/65">
                <span className="text-emerald-300 font-medium">
                  Green group: kept open for your review · Temp tabs closed automatically
                </span>
                <span className="mono text-[10.5px] text-emerald-300">Tab Group: Deliverable</span>
              </div>
            </>
          )}
        </div>
      </ChromeWindow>
    </div>
  );
}

function OneCallStage({ active }: { active: boolean }) {
  const { enabled: roaming, heroOneCallStep } = useCursorChoreography();
  const fastSteps = [
    { label: "Open app.kestrel.io/orders", dur: "0.3s" },
    { label: 'Click filter "Paid"', dur: "0.2s" },
    { label: "Extract matching rows", dur: "0.5s" },
    { label: "Write ./exports/orders.json", dur: "0.1s" },
  ];

  const filterActive = roaming ? heroOneCallStep >= 2 : true;
  const rowsExtracted = roaming ? heroOneCallStep >= 3 : true;
  const fileSaved = roaming ? heroOneCallStep >= 4 : true;

  const orders = [
    { id: "#1084", customer: "Halcyon Audio", status: "Paid", amt: "$1,248.50", paid: true },
    { id: "#1085", customer: "Solis Robotics", status: "Pending", amt: "$640.00", paid: false },
    { id: "#1086", customer: "Vektor Labs", status: "Paid", amt: "$2,140.00", paid: true },
    { id: "#1087", customer: "Meridian Bio", status: "Paid", amt: "$892.00", paid: true },
  ];

  return (
    <div className={`work-stage ${active && !roaming ? "cbu-anim-on" : ""}`}>
      <ChromeWindow
        variant="light"
        loading={roaming && heroOneCallStep === 3}
        extensionStatus="connected"
        profileLabel="M"
        personalTabs={[{ title: "Gmail (4)", icon: "gmail" }]}
        tabGroups={[
          {
            label: "browser_run",
            color: fileSaved ? "green" : "blue",
            tabs: [
              {
                title: "Orders - Kestrel",
                icon: "orders",
                active: true,
                badge: fileSaved ? "deliverable" : "active",
              },
            ],
          },
        ]}
        url={{ protocol: "https://", host: "app.kestrel.io", path: "/orders" }}
        downloadBadge={{ filename: "orders.json · 18.4 KB", active: fileSaved }}
        downloadHighlight={fileSaved}
      >
        <div className="flex flex-1 min-h-0 bg-white text-[#0b1220]">
          {/* Real Chrome Extension Execution Side Panel */}
          <aside className="w-full sm:w-[264px] shrink-0 bg-[#f8fafc] border-r border-[#090e1a]/10 p-3.5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between gap-2 pb-2 border-b border-[#090e1a]/8">
                <span className="text-[11.5px] font-semibold text-[#0b1220]">
                  browser_run · 1 tool call
                </span>
                <span className="mono text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#1a73e8] text-white">
                  Live run
                </span>
              </div>

              <div className="space-y-1.5 mt-3">
                {fastSteps.map((step, i) => {
                  const isStepActive = roaming && i + 1 === heroOneCallStep;
                  const isStepDone = !roaming || i + 1 < heroOneCallStep || (i + 1 === 4 && fileSaved);
                  return (
                    <div
                      key={step.label}
                      data-cursor-target={active ? `hero-onecall-${i + 1}` : undefined}
                      data-cursor-anchor="0.86,0.5"
                      className={`${roaming ? "" : "cbu-fast-row"} rounded-lg px-2.5 py-2 border flex items-center justify-between gap-2 text-[11px] transition-all duration-200 ${
                        isStepActive
                          ? "bg-[#e8f0fe] border-[#1a73e8] shadow-[0_0_0_2px_rgba(26,115,232,0.16)]"
                          : "bg-white border-[#090e1a]/8"
                      }`}
                      style={!roaming ? { animationDelay: `${i * 0.75}s` } : undefined}
                    >
                      <span className="truncate font-medium text-[#0b1220]/90">
                        {i + 1}. {step.label}
                      </span>
                      <span className="inline-flex items-center gap-1 shrink-0 mono text-[10px]">
                        {isStepDone ? (
                          <>
                            <span className="text-emerald-700 font-semibold">{step.dur}</span>
                            <Check size={11} weight="bold" className="text-emerald-600" aria-hidden="true" />
                          </>
                        ) : isStepActive ? (
                          <>
                            <span className="text-[#1a73e8] font-semibold">Running</span>
                            <CircleNotch
                              size={11}
                              weight="bold"
                              className="text-[#1a73e8] animate-spin"
                              aria-hidden="true"
                            />
                          </>
                        ) : (
                          <>
                            <span className="text-[#0b1220]/45">Queued</span>
                            <Clock size={11} className="text-[#0b1220]/35" aria-hidden="true" />
                          </>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="pt-2.5 border-t border-[#090e1a]/8 flex items-center justify-between text-[10.5px] text-[#0b1220]/65 tabular-nums">
              <span>Total: 1.1s</span>
              <span className="text-emerald-700 font-semibold">1 MCP call</span>
            </div>
          </aside>

          {/* Main Kestrel Orders App beside Side Panel */}
          <div className="hidden sm:flex flex-1 min-w-0 p-4 flex-col justify-between bg-white">
            <div>
              <div className="flex items-center justify-between pb-2.5 border-b border-[#090e1a]/8">
                <div>
                  <span className="text-[13.5px] font-semibold text-[#0b1220]">Orders</span>
                  <span className="ml-2 text-[11px] text-[#0b1220]/50">Kestrel Workspace</span>
                </div>
                <span
                  className={`text-[11px] px-2.5 py-1 rounded-md font-semibold border transition-all duration-200 ${
                    filterActive
                      ? "bg-[#1a73e8] text-white border-[#1a73e8] shadow-sm"
                      : "bg-[#f8fafc] text-[#0b1220]/75 border-[#090e1a]/12"
                  }`}
                >
                  {filterActive ? "Status: Paid (3)" : "Status: All (4)"}
                </span>
              </div>

              <div
                tabIndex={0}
                role="region"
                aria-label="Workspace customer orders"
                className="overflow-x-auto mt-2"
              >
                <table className="w-full text-left border-collapse text-[11.5px] tabular-nums">
                  <thead>
                    <tr className="text-[#0b1220]/50 text-[10.5px] border-b border-[#090e1a]/8">
                      <th scope="col" className="py-1.5 font-medium">
                        Order
                      </th>
                      <th scope="col" className="py-1.5 font-medium">
                        Customer
                      </th>
                      <th scope="col" className="py-1.5 font-medium">
                        Status
                      </th>
                      <th scope="col" className="py-1.5 font-medium text-right">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#090e1a]/6">
                    {orders.map((r) => {
                      const dimmed = filterActive && !r.paid;
                      const extracted = rowsExtracted && r.paid;
                      return (
                        <tr
                          key={r.id}
                          className={`transition-all duration-200 ${
                            dimmed ? "opacity-30 line-through" : extracted ? "bg-emerald-50/55" : ""
                          }`}
                        >
                          <td className="py-2 font-medium mono text-[#0b1220]/60">{r.id}</td>
                          <td className="py-2 font-medium text-[#0b1220]">{r.customer}</td>
                          <td className="py-2">
                            <span
                              className={`text-[10.5px] font-semibold ${
                                r.paid ? "text-emerald-700" : "text-amber-700"
                              }`}
                            >
                              {r.status}
                            </span>
                          </td>
                          <td className="py-2 text-right font-semibold mono text-[#0b1220]">{r.amt}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-lg bg-[#f8fafc] border border-[#090e1a]/8 px-3 py-2 text-[11px] text-[#0b1220]/70 flex items-center justify-between gap-2">
              <span>{filterActive ? "Showing 3 of 4 orders" : "Showing 4 of 4 orders"}</span>
              <span className={`font-semibold mono text-[10.5px] ${fileSaved ? "text-emerald-700" : "text-[#0b1220]/60"}`}>
                {fileSaved ? "Exported to ./exports/orders.json" : "Ready to export"}
              </span>
            </div>
          </div>
        </div>
      </ChromeWindow>
    </div>
  );
}

function LocalBridgeStage({ active }: { active: boolean }) {
  const nodes = [
    { icon: TerminalWindow, title: "Coding Agent", sub: "Claude Code, Codex, Cursor" },
    { icon: Cpu, title: "Local MCP", sub: "Stdio · ~1.8 KB page outline" },
    { icon: PlugsConnected, title: "Localhost Bridge", sub: "ws://127.0.0.1 · private" },
    { icon: Globe, title: "Your Chrome", sub: "Signed-in tabs & cookies" },
  ];

  return (
    <div className={`work-stage ${active ? "cbu-anim-on" : ""}`}>
      <ChromeWindow
        variant="dark"
        extensionStatus="connected"
        profileLabel="M"
        personalTabs={[{ title: "Gmail (4)", icon: "gmail" }]}
        tabGroups={[
          {
            label: "127.0.0.1",
            color: "green",
            tabs: [{ title: "Local Bridge · Status", icon: "chrome", active: true, badge: "active" }],
          },
        ]}
        url={{ protocol: "chrome://", host: "extensions", path: "/local-bridge" }}
      >
        <div className="relative flex-1 min-h-0 p-4 sm:p-5 flex flex-col justify-between bg-[#14171f] text-white">
          <div className="rounded-xl border border-dashed border-[#8ab4f8]/35 bg-white/[0.03] p-4 relative flex-1 flex flex-col justify-between">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <LockSimple size={14} weight="fill" className="text-emerald-400" aria-hidden="true" />
                <span className="text-[12px] font-semibold text-white">
                  Inside Your Computer · 127.0.0.1 only
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="mono text-[10.5px] px-2 py-0.5 rounded-full bg-white/[0.08] text-white/80">
                  Latency: 11ms
                </span>
                <span className="mono text-[10.5px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-400/25">
                  v0.6.4 Connected
                </span>
              </div>
            </div>

            <div className="relative grid grid-cols-2 md:grid-cols-4 gap-2.5 items-stretch my-3">
              <div className="cbu-bridge-track hidden md:block" aria-hidden="true">
                <span className="cbu-bridge-pulse" />
              </div>

              {nodes.map((node, i) => {
                const Icon = node.icon;
                return (
                  <div
                    key={node.title}
                    data-cursor-target={
                      active && i === 0 ? "hero-bridge-agent" : active && i === 3 ? "hero-bridge-chrome" : undefined
                    }
                    data-cursor-anchor="0.5,0.5"
                    className="cbu-node-card relative z-[1] rounded-xl bg-[#1f2430] border border-white/12 p-3 flex flex-col gap-1"
                    style={{ animationDelay: `${i * 0.4}s` }}
                  >
                    <span className="w-6 h-6 rounded-md bg-[#1a73e8]/25 text-[#8ab4f8] grid place-items-center">
                      <Icon size={14} weight="duotone" aria-hidden="true" />
                    </span>
                    <div className="text-[12px] font-semibold text-white">{node.title}</div>
                    <div className="text-[10.5px] text-white/60 leading-snug">{node.sub}</div>
                  </div>
                );
              })}
            </div>

            <div className="pt-2.5 border-t border-white/10 flex flex-wrap items-center justify-between gap-2 text-[11px]">
              <span className="mono text-[10.5px] text-emerald-300 truncate">
                POST 127.0.0.1/action click(&quot;Export CSV&quot;) -&gt; 200 OK (11ms)
              </span>
              <span className="text-white/55">0 bytes sent to cloud</span>
            </div>
          </div>
        </div>
      </ChromeWindow>
    </div>
  );
}

export function HeroBrowserScene({ id, active }: HeroBrowserSceneProps) {
  switch (id) {
    case "tab-groups":
      return <TabGroupsStage active={active} />;
    case "one-call":
      return <OneCallStage active={active} />;
    case "architecture":
      return <LocalBridgeStage active={active} />;
    default:
      return <LiveChromeStage active={active} />;
  }
}
