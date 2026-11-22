import { useSyncExternalStore } from "react";
import { clamp, evaluateQuadraticArc, type Point } from "./cursorPhysics";

export type HeroStep = "park" | "focus-12" | "toggle-14" | "confirm-19";
export type HeroTabPhase = "blue" | "green";
export type HeroOneCallStep = 1 | 2 | 3 | 4;
export type Feat1Step = "idle" | "profile" | "deploy";
export type Feat2Step = "idle" | "step1" | "export" | "saved";
export type IsolationStep = "working" | "deliverable" | "handoff";
export type BaSubStep = "idle" | "filter-1" | "export-2" | "run-3";

export const REPO_GLOW_ACTIVE = "#339cff";
export const REPO_GLOW_DELIVERABLE = "#22c55e";
export const REPO_GLOW_HANDOFF = "#facc15";

export interface CursorChoreographyState {
  enabled: boolean;
  act: string;
  heroStep: HeroStep;
  heroTabPhase: HeroTabPhase;
  heroOneCallStep: HeroOneCallStep;
  activeClientIdx: number | null;
  feat1Step: Feat1Step;
  feat2Step: Feat2Step;
  isolationStep: IsolationStep;
  baStep: number;
  baSubStep: BaSubStep;
  activeSpeedIdx: number | null;
  installReady: boolean;
}

export interface FrameDirectorDirective {
  targetPoint: Point | null;
  visible: boolean;
  glowColor: string;
  pillText: string;
  wobble: boolean;
  clickKey: string | null;
  clickTargetId?: string | null;
}

const DEFAULT_STATE: CursorChoreographyState = {
  enabled: false,
  act: "park",
  heroStep: "park",
  heroTabPhase: "blue",
  heroOneCallStep: 1,
  activeClientIdx: null,
  feat1Step: "idle",
  feat2Step: "idle",
  isolationStep: "working",
  baStep: 0,
  baSubStep: "idle",
  activeSpeedIdx: null,
  installReady: false,
};

let currentState: CursorChoreographyState = { ...DEFAULT_STATE };
const listeners = new Set<() => void>();

function statesEqual(a: CursorChoreographyState, b: CursorChoreographyState): boolean {
  return (
    a.enabled === b.enabled &&
    a.act === b.act &&
    a.heroStep === b.heroStep &&
    a.heroTabPhase === b.heroTabPhase &&
    a.heroOneCallStep === b.heroOneCallStep &&
    a.activeClientIdx === b.activeClientIdx &&
    a.feat1Step === b.feat1Step &&
    a.feat2Step === b.feat2Step &&
    a.isolationStep === b.isolationStep &&
    a.baStep === b.baStep &&
    a.baSubStep === b.baSubStep &&
    a.activeSpeedIdx === b.activeSpeedIdx &&
    a.installReady === b.installReady
  );
}

function emitState(next: CursorChoreographyState) {
  if (statesEqual(currentState, next)) return;
  currentState = next;
  listeners.forEach((listener) => listener());
}

export function useCursorChoreography(): CursorChoreographyState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => currentState,
    () => DEFAULT_STATE
  );
}

export function setRoamingEnabled(enabled: boolean) {
  emitState({ ...currentState, enabled });
}

type StageId =
  | "hero"
  | "feat1"
  | "feat2"
  | "isolation"
  | "before-after"
  | "install"
  | "transit"
  | "outro";

type DemoStageId = Exclude<StageId, "transit" | "outro">;

const DEMO_STAGES: readonly DemoStageId[] = [
  "hero",
  "feat1",
  "feat2",
  "isolation",
  "before-after",
  "install",
];

// True Schmitt-trigger hysteresis (ENTER > HOLD) prevents stage <-> transit oscillation.
const STAGE_HOLD_RATIO = 0.5;
const STAGE_ENTER_RATIO = 0.6;
const STAGE_DIRECT_SWITCH_MARGIN = 0.08;
const MIN_STAGE_DWELL_SEC = 0.35;
const CROSS_STAGE_TRANSITION_SEC = 0.68;
const INTRA_STAGE_TRANSITION_SEC = 0.48;

let activeHeroTab = "live-chrome";
let manualIsolationPicked = false;
let currentBeforeAfterStep = 0;

let activeStage: StageId = "hero";
let stageInitialized = false;
let stageEnterClock = 0;
let stageTransitionSec = CROSS_STAGE_TRANSITION_SEC;
let stageResetPending = false;
let routineEpoch = 0;
let transitionFromPoint: Point | null = null;
let lastEmittedPoint: Point | null = null;
let lastEmittedGlow = REPO_GLOW_ACTIVE;

export function notifyActiveHeroTab(tabId: string) {
  if (!tabId || tabId === activeHeroTab) return;
  activeHeroTab = tabId;
  if (activeStage === "hero") {
    stageResetPending = true;
  }
}

export function notifyManualIsolationPick(picked: boolean) {
  manualIsolationPicked = picked;
}

export function notifyManualBeforeAfterStep(step: number) {
  const clamped = Math.max(0, Math.min(3, Math.round(step)));
  if (clamped === currentBeforeAfterStep) return;
  currentBeforeAfterStep = clamped;
  if (activeStage === "before-after") {
    stageResetPending = true;
  }
}

export function resetDirectorDefaults() {
  activeHeroTab = "live-chrome";
  manualIsolationPicked = false;
  currentBeforeAfterStep = 0;
  activeStage = "hero";
  stageInitialized = false;
  stageEnterClock = 0;
  stageTransitionSec = CROSS_STAGE_TRANSITION_SEC;
  stageResetPending = false;
  routineEpoch = 0;
  transitionFromPoint = null;
  lastEmittedPoint = null;
  lastEmittedGlow = REPO_GLOW_ACTIVE;
  emitState({ ...DEFAULT_STATE });
}

export function getAnchorPoint(targetId: string): Point | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector<HTMLElement>(`[data-cursor-target="${targetId}"]`);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const anchorAttr = el.getAttribute("data-cursor-anchor");
  let rx = 0.5;
  let ry = 0.5;
  if (anchorAttr) {
    const [sx, sy] = anchorAttr.split(",");
    const px = Number.parseFloat(sx);
    const py = Number.parseFloat(sy);
    if (Number.isFinite(px)) rx = clamp(px, 0, 1);
    if (Number.isFinite(py)) ry = clamp(py, 0, 1);
  }
  return {
    x: rect.left + rect.width * rx,
    y: rect.top + rect.height * ry,
  };
}

export function lerpTargets(
  idA: string,
  idB: string,
  t: number,
  side: 1 | -1 = 1,
  curvature = 0.16
): Point | null {
  const a = getAnchorPoint(idA);
  const b = getAnchorPoint(idB);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return evaluateQuadraticArc(a, b, clamp(t, 0, 1), curvature, side).point;
}

function easeInOutCubic(t: number): number {
  const u = clamp(t, 0, 1);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

function getStageElement(stage: DemoStageId): HTMLElement | null {
  switch (stage) {
    case "hero":
      return (
        document.querySelector<HTMLElement>(".hero-work") ||
        document.querySelector<HTMLElement>("#hero")
      );
    case "feat1":
      return document.querySelectorAll<HTMLElement>(".feats .feature")[0] ?? null;
    case "feat2":
      return document.querySelectorAll<HTMLElement>(".feats .feature")[1] ?? null;
    case "isolation":
      return document.querySelector<HTMLElement>('[data-cursor-section="isolation"]');
    case "before-after":
      return (
        document.querySelector<HTMLElement>("#before-after .ba-frame") ||
        document.querySelector<HTMLElement>("#before-after")
      );
    case "install":
      return (
        document.querySelector<HTMLElement>("#install .install-shell") ||
        document.querySelector<HTMLElement>("#install")
      );
  }
}

function getVisibleRatio(el: HTMLElement | null, vh: number): number {
  if (!el || vh <= 0) return 0;
  const rect = el.getBoundingClientRect();
  if (rect.height <= 0 || rect.width <= 0) return 0;
  const visibleHeight = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
  const denom = Math.max(1, Math.min(rect.height, vh));
  return clamp(visibleHeight / denom, 0, 1);
}

function beginTransition(nextStage: StageId, clockSec: number, durationSec: number) {
  activeStage = nextStage;
  stageEnterClock = clockSec;
  stageTransitionSec = durationSec;
  stageResetPending = false;
  routineEpoch += 1;
  transitionFromPoint = lastEmittedPoint ? { ...lastEmittedPoint } : null;
}

function resolveStage(clockSec: number, vh: number): StageId {
  const lightFlood = document.querySelector<HTMLElement>("#light-flood");
  if (lightFlood) {
    const lfRect = lightFlood.getBoundingClientRect();
    if (lfRect.top < vh * 0.56) {
      if (activeStage !== "outro") {
        beginTransition("outro", clockSec, CROSS_STAGE_TRANSITION_SEC);
      }
      stageInitialized = true;
      return "outro";
    }
    if (activeStage === "outro" && lfRect.top >= vh * 0.62) {
      activeStage = "transit";
    }
  }

  const ratios: Partial<Record<DemoStageId, number>> = {};
  let bestStage: DemoStageId | null = null;
  let bestRatio = 0;

  for (const stage of DEMO_STAGES) {
    const ratio = getVisibleRatio(getStageElement(stage), vh);
    ratios[stage] = ratio;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestStage = stage;
    }
  }

  const heroEl = getStageElement("hero");
  const heroRect = heroEl?.getBoundingClientRect() ?? null;
  const heroRatio = ratios.hero ?? 0;
  const isHeroTopPinned =
    (window.scrollY || window.pageYOffset || 0) <= 180 &&
    heroRect !== null &&
    heroRect.top > 0 &&
    heroRatio >= 0.2;

  if (!stageInitialized) {
    stageInitialized = true;
    const initial: StageId = isHeroTopPinned
      ? "hero"
      : bestStage && bestRatio >= STAGE_HOLD_RATIO
        ? bestStage
        : "transit";
    activeStage = initial;
    stageEnterClock = clockSec;
    stageTransitionSec = INTRA_STAGE_TRANSITION_SEC;
    stageResetPending = false;
    return activeStage;
  }

  if (activeStage !== "transit" && activeStage !== "outro") {
    const currentRatio = ratios[activeStage] ?? 0;
    if (currentRatio >= STAGE_HOLD_RATIO || (activeStage === "hero" && isHeroTopPinned)) {
      if (stageResetPending) {
        beginTransition(activeStage, clockSec, INTRA_STAGE_TRANSITION_SEC);
      }
      return activeStage;
    }
    if (clockSec - stageEnterClock < MIN_STAGE_DWELL_SEC && currentRatio > 0.05) {
      return activeStage;
    }
    let target: StageId = "transit";
    if (isHeroTopPinned && activeStage !== "hero") {
      target = "hero";
    } else if (
      bestStage &&
      bestStage !== activeStage &&
      bestRatio >= STAGE_HOLD_RATIO &&
      bestRatio >= currentRatio + STAGE_DIRECT_SWITCH_MARGIN
    ) {
      target = bestStage;
    }
    beginTransition(target, clockSec, CROSS_STAGE_TRANSITION_SEC);
    return activeStage;
  }

  if (clockSec - stageEnterClock < MIN_STAGE_DWELL_SEC && !isHeroTopPinned) {
    stageResetPending = false;
    return activeStage;
  }

  if (isHeroTopPinned) {
    beginTransition("hero", clockSec, CROSS_STAGE_TRANSITION_SEC);
  } else if (bestStage && bestRatio >= STAGE_ENTER_RATIO) {
    beginTransition(bestStage, clockSec, CROSS_STAGE_TRANSITION_SEC);
  } else {
    stageResetPending = false;
  }

  return activeStage;
}

interface RoutineStep {
  id: string;
  targetId: string;
  glowColor: string;
  pillText: string;
  wobble?: boolean;
  side?: 1 | -1;
  curvature?: number;
  dwellSec: number;
  moveSec?: number;
  clickAtSec: number | null;
  onEnterState: (base: CursorChoreographyState) => CursorChoreographyState;
  onClickState?: (base: CursorChoreographyState) => CursorChoreographyState;
}

function getHeroSteps(): RoutineStep[] {
  if (activeHeroTab === "tab-groups") {
    return [
      {
        id: "tab-blue",
        targetId: "hero-tab-blue",
        glowColor: REPO_GLOW_ACTIVE,
        pillText: "Order Audit tab",
        dwellSec: 2.0,
        moveSec: 0.54,
        clickAtSec: 0.8,
        side: 1,
        curvature: 0.14,
        onEnterState: (base) => ({
          ...base,
          act: "hero-tab-groups",
          heroStep: "park",
          heroTabPhase: "blue",
        }),
        onClickState: (base) => ({
          ...base,
          act: "hero-tab-groups",
          heroStep: "park",
          heroTabPhase: "blue",
        }),
      },
      {
        id: "tab-green",
        targetId: "hero-tab-green",
        glowColor: REPO_GLOW_DELIVERABLE,
        pillText: "Deliverable tab",
        dwellSec: 2.1,
        moveSec: 0.56,
        clickAtSec: 0.72,
        side: -1,
        curvature: 0.16,
        onEnterState: (base) => ({
          ...base,
          act: "hero-tab-groups",
          heroStep: "park",
          heroTabPhase: "blue",
        }),
        onClickState: (base) => ({
          ...base,
          act: "hero-tab-groups",
          heroStep: "park",
          heroTabPhase: "green",
        }),
      },
    ];
  }

  if (activeHeroTab === "one-call") {
    return [
      {
        id: "oc-1",
        targetId: "hero-onecall-1",
        glowColor: REPO_GLOW_ACTIVE,
        pillText: "Open /orders",
        dwellSec: 1.65,
        moveSec: 0.5,
        clickAtSec: 0.78,
        side: 1,
        curvature: 0.14,
        onEnterState: (base) => ({
          ...base,
          act: "hero-one-call",
          heroStep: "park",
          heroOneCallStep: 1,
        }),
        onClickState: (base) => ({
          ...base,
          act: "hero-one-call",
          heroStep: "park",
          heroOneCallStep: 1,
        }),
      },
      {
        id: "oc-2",
        targetId: "hero-onecall-2",
        glowColor: REPO_GLOW_ACTIVE,
        pillText: "Filter Paid",
        dwellSec: 1.65,
        moveSec: 0.5,
        clickAtSec: 0.68,
        side: 1,
        curvature: 0.12,
        onEnterState: (base) => ({
          ...base,
          act: "hero-one-call",
          heroStep: "park",
          heroOneCallStep: 1,
        }),
        onClickState: (base) => ({
          ...base,
          act: "hero-one-call",
          heroStep: "park",
          heroOneCallStep: 2,
        }),
      },
      {
        id: "oc-3",
        targetId: "hero-onecall-3",
        glowColor: REPO_GLOW_ACTIVE,
        pillText: "Extract rows",
        dwellSec: 1.7,
        moveSec: 0.5,
        clickAtSec: 0.68,
        side: 1,
        curvature: 0.12,
        onEnterState: (base) => ({
          ...base,
          act: "hero-one-call",
          heroStep: "park",
          heroOneCallStep: 2,
        }),
        onClickState: (base) => ({
          ...base,
          act: "hero-one-call",
          heroStep: "park",
          heroOneCallStep: 3,
        }),
      },
      {
        id: "oc-4",
        targetId: "hero-onecall-4",
        glowColor: REPO_GLOW_DELIVERABLE,
        pillText: "Save orders.json",
        dwellSec: 1.95,
        moveSec: 0.52,
        clickAtSec: 0.7,
        side: 1,
        curvature: 0.14,
        onEnterState: (base) => ({
          ...base,
          act: "hero-one-call",
          heroStep: "park",
          heroOneCallStep: 3,
        }),
        onClickState: (base) => ({
          ...base,
          act: "hero-one-call",
          heroStep: "park",
          heroOneCallStep: 4,
        }),
      },
    ];
  }

  if (activeHeroTab === "architecture") {
    return [
      {
        id: "bridge-agent",
        targetId: "hero-bridge-agent",
        glowColor: REPO_GLOW_ACTIVE,
        pillText: "MCP bridge",
        dwellSec: 1.95,
        moveSec: 0.54,
        clickAtSec: 0.8,
        side: -1,
        curvature: 0.18,
        onEnterState: (base) => ({ ...base, act: "hero-architecture", heroStep: "park" }),
        onClickState: (base) => ({ ...base, act: "hero-architecture", heroStep: "park" }),
      },
      {
        id: "bridge-chrome",
        targetId: "hero-bridge-chrome",
        glowColor: REPO_GLOW_DELIVERABLE,
        pillText: "Native driver",
        dwellSec: 2.05,
        moveSec: 0.56,
        clickAtSec: 0.72,
        side: 1,
        curvature: 0.18,
        onEnterState: (base) => ({ ...base, act: "hero-architecture", heroStep: "park" }),
        onClickState: (base) => ({ ...base, act: "hero-architecture", heroStep: "park" }),
      },
    ];
  }

  // Default: "live-chrome"
  return [
    {
      id: "park",
      targetId: "hero-park",
      glowColor: REPO_GLOW_ACTIVE,
      pillText: "Agent ready",
      wobble: true,
      dwellSec: 0.82,
      moveSec: 0.48,
      clickAtSec: null,
      side: 1,
      curvature: 0.16,
      onEnterState: (base) => ({ ...base, act: "hero-park", heroStep: "park" }),
    },
    {
      id: "focus-12",
      targetId: "hero-12",
      glowColor: REPO_GLOW_ACTIVE,
      pillText: "Verify invoice email",
      dwellSec: 1.55,
      moveSec: 0.52,
      clickAtSec: 0.68,
      side: 1,
      curvature: 0.18,
      onEnterState: (base) => ({ ...base, act: "hero-park", heroStep: "park" }),
      onClickState: (base) => ({ ...base, act: "hero-12", heroStep: "focus-12" }),
    },
    {
      id: "toggle-14",
      targetId: "hero-14",
      glowColor: REPO_GLOW_ACTIVE,
      pillText: "Enable annual (-20%)",
      dwellSec: 1.55,
      moveSec: 0.52,
      clickAtSec: 0.68,
      side: -1,
      curvature: 0.16,
      onEnterState: (base) => ({ ...base, act: "hero-12", heroStep: "focus-12" }),
      onClickState: (base) => ({ ...base, act: "hero-14", heroStep: "toggle-14" }),
    },
    {
      id: "confirm-19",
      targetId: "hero-19",
      glowColor: REPO_GLOW_DELIVERABLE,
      pillText: "Confirm annual plan",
      dwellSec: 1.9,
      moveSec: 0.54,
      clickAtSec: 0.7,
      side: 1,
      curvature: 0.18,
      onEnterState: (base) => ({ ...base, act: "hero-14", heroStep: "toggle-14" }),
      onClickState: (base) => ({ ...base, act: "hero-19", heroStep: "confirm-19" }),
    },
  ];
}

function getFeat1Steps(): RoutineStep[] {
  return [
    {
      id: "profile",
      targetId: "feat1-profile",
      glowColor: REPO_GLOW_ACTIVE,
      pillText: "Use active Chrome profile",
      dwellSec: 1.9,
      moveSec: 0.54,
      clickAtSec: 0.82,
      side: 1,
      curvature: 0.18,
      onEnterState: (base) => ({ ...base, act: "feat1", heroStep: "confirm-19", feat1Step: "idle" }),
      onClickState: (base) => ({ ...base, act: "feat1", heroStep: "confirm-19", feat1Step: "profile" }),
    },
    {
      id: "deploy",
      targetId: "feat1-deploy",
      glowColor: REPO_GLOW_DELIVERABLE,
      pillText: "Promote to staging",
      dwellSec: 2.05,
      moveSec: 0.54,
      clickAtSec: 0.7,
      side: -1,
      curvature: 0.18,
      onEnterState: (base) => ({ ...base, act: "feat1", heroStep: "confirm-19", feat1Step: "profile" }),
      onClickState: (base) => ({ ...base, act: "feat1", heroStep: "confirm-19", feat1Step: "deploy" }),
    },
  ];
}

function getFeat2Steps(): RoutineStep[] {
  return [
    {
      id: "step1",
      targetId: "feat2-step1",
      glowColor: REPO_GLOW_ACTIVE,
      pillText: "Open /invoices",
      dwellSec: 1.75,
      moveSec: 0.52,
      clickAtSec: 0.8,
      side: 1,
      curvature: 0.16,
      onEnterState: (base) => ({
        ...base,
        act: "feat2",
        heroStep: "confirm-19",
        feat1Step: "deploy",
        feat2Step: "idle",
      }),
      onClickState: (base) => ({
        ...base,
        act: "feat2",
        heroStep: "confirm-19",
        feat1Step: "deploy",
        feat2Step: "step1",
      }),
    },
    {
      id: "export",
      targetId: "feat2-export",
      glowColor: REPO_GLOW_ACTIVE,
      pillText: "Click Export CSV",
      dwellSec: 1.75,
      moveSec: 0.52,
      clickAtSec: 0.68,
      side: -1,
      curvature: 0.16,
      onEnterState: (base) => ({
        ...base,
        act: "feat2",
        heroStep: "confirm-19",
        feat1Step: "deploy",
        feat2Step: "step1",
      }),
      onClickState: (base) => ({
        ...base,
        act: "feat2",
        heroStep: "confirm-19",
        feat1Step: "deploy",
        feat2Step: "export",
      }),
    },
    {
      id: "saved",
      targetId: "feat2-saved",
      glowColor: REPO_GLOW_DELIVERABLE,
      pillText: "Saved orders.json",
      dwellSec: 2.0,
      moveSec: 0.54,
      clickAtSec: 0.7,
      side: 1,
      curvature: 0.16,
      onEnterState: (base) => ({
        ...base,
        act: "feat2",
        heroStep: "confirm-19",
        feat1Step: "deploy",
        feat2Step: "export",
      }),
      onClickState: (base) => ({
        ...base,
        act: "feat2",
        heroStep: "confirm-19",
        feat1Step: "deploy",
        feat2Step: "saved",
      }),
    },
  ];
}

function getIsolationSteps(): RoutineStep[] {
  const preserveIso = (step: IsolationStep) =>
    manualIsolationPicked ? currentState.isolationStep : step;

  return [
    {
      id: "working",
      targetId: "iso-working",
      glowColor: REPO_GLOW_ACTIVE,
      pillText: "Checkout QA tab",
      dwellSec: 1.85,
      moveSec: 0.52,
      clickAtSec: 0.8,
      side: 1,
      curvature: 0.16,
      onEnterState: (base) => ({
        ...base,
        act: "isolation",
        heroStep: "confirm-19",
        feat1Step: "deploy",
        feat2Step: "saved",
        isolationStep: preserveIso("working"),
      }),
      onClickState: (base) => ({
        ...base,
        act: "isolation",
        heroStep: "confirm-19",
        feat1Step: "deploy",
        feat2Step: "saved",
        isolationStep: preserveIso("working"),
      }),
    },
    {
      id: "deliverable",
      targetId: "iso-deliverable",
      glowColor: REPO_GLOW_DELIVERABLE,
      pillText: "Q4 Revenue deliverable",
      dwellSec: 1.85,
      moveSec: 0.54,
      clickAtSec: 0.7,
      side: -1,
      curvature: 0.16,
      onEnterState: (base) => ({
        ...base,
        act: "isolation",
        heroStep: "confirm-19",
        feat1Step: "deploy",
        feat2Step: "saved",
        isolationStep: preserveIso("working"),
      }),
      onClickState: (base) => ({
        ...base,
        act: "isolation",
        heroStep: "confirm-19",
        feat1Step: "deploy",
        feat2Step: "saved",
        isolationStep: preserveIso("deliverable"),
      }),
    },
    {
      id: "handoff",
      targetId: "iso-handoff",
      glowColor: REPO_GLOW_HANDOFF,
      pillText: "Pause for 2FA",
      dwellSec: 1.95,
      moveSec: 0.54,
      clickAtSec: 0.7,
      side: 1,
      curvature: 0.16,
      onEnterState: (base) => ({
        ...base,
        act: "isolation",
        heroStep: "confirm-19",
        feat1Step: "deploy",
        feat2Step: "saved",
        isolationStep: preserveIso("deliverable"),
      }),
      onClickState: (base) => ({
        ...base,
        act: "isolation",
        heroStep: "confirm-19",
        feat1Step: "deploy",
        feat2Step: "saved",
        isolationStep: preserveIso("handoff"),
      }),
    },
  ];
}

function getBeforeAfterSteps(): RoutineStep[] {
  const stepIdx = currentBeforeAfterStep;
  const baseDone = {
    heroStep: "confirm-19" as const,
    feat1Step: "deploy" as const,
    feat2Step: "saved" as const,
  };

  if (stepIdx === 0) {
    return [
      {
        id: "ba-locked",
        targetId: "ba-locked",
        glowColor: REPO_GLOW_HANDOFF,
        pillText: "Blocked on login",
        dwellSec: 2.2,
        moveSec: 0.54,
        clickAtSec: 0.85,
        side: 1,
        curvature: 0.15,
        onEnterState: (base) => ({ ...base, ...baseDone, act: "ba-0", baStep: 0, baSubStep: "idle" }),
        onClickState: (base) => ({ ...base, ...baseDone, act: "ba-0", baStep: 0, baSubStep: "idle" }),
      },
    ];
  }

  if (stepIdx === 1) {
    return [
      {
        id: "ba-group",
        targetId: "ba-group",
        glowColor: REPO_GLOW_ACTIVE,
        pillText: "Signed-in Chrome group",
        dwellSec: 2.2,
        moveSec: 0.54,
        clickAtSec: 0.85,
        side: 1,
        curvature: 0.15,
        onEnterState: (base) => ({ ...base, ...baseDone, act: "ba-1", baStep: 1, baSubStep: "idle" }),
        onClickState: (base) => ({ ...base, ...baseDone, act: "ba-1", baStep: 1, baSubStep: "idle" }),
      },
    ];
  }

  if (stepIdx === 2) {
    return [
      {
        id: "ba-1",
        targetId: "ba-1",
        glowColor: REPO_GLOW_ACTIVE,
        pillText: "Filter: Paid only",
        dwellSec: 1.75,
        moveSec: 0.52,
        clickAtSec: 0.82,
        side: 1,
        curvature: 0.15,
        onEnterState: (base) => ({ ...base, ...baseDone, act: "ba-2", baStep: 2, baSubStep: "idle" }),
        onClickState: (base) => ({ ...base, ...baseDone, act: "ba-2", baStep: 2, baSubStep: "filter-1" }),
      },
      {
        id: "ba-2",
        targetId: "ba-2",
        glowColor: REPO_GLOW_ACTIVE,
        pillText: "Export CSV",
        dwellSec: 1.75,
        moveSec: 0.52,
        clickAtSec: 0.68,
        side: -1,
        curvature: 0.15,
        onEnterState: (base) => ({ ...base, ...baseDone, act: "ba-2", baStep: 2, baSubStep: "filter-1" }),
        onClickState: (base) => ({ ...base, ...baseDone, act: "ba-2", baStep: 2, baSubStep: "export-2" }),
      },
      {
        id: "ba-3",
        targetId: "ba-3",
        glowColor: REPO_GLOW_DELIVERABLE,
        pillText: "Save report",
        dwellSec: 2.05,
        moveSec: 0.54,
        clickAtSec: 0.7,
        side: 1,
        curvature: 0.15,
        onEnterState: (base) => ({ ...base, ...baseDone, act: "ba-2", baStep: 2, baSubStep: "export-2" }),
        onClickState: (base) => ({ ...base, ...baseDone, act: "ba-2", baStep: 2, baSubStep: "run-3" }),
      },
    ];
  }

  return [
    {
      id: "ba-3-final",
      targetId: "ba-3",
      glowColor: REPO_GLOW_DELIVERABLE,
      pillText: "Done · Saved",
      dwellSec: 1.85,
      moveSec: 0.54,
      clickAtSec: 0.82,
      side: 1,
      curvature: 0.15,
      onEnterState: (base) => ({ ...base, ...baseDone, act: "ba-3", baStep: 3, baSubStep: "run-3" }),
      onClickState: (base) => ({ ...base, ...baseDone, act: "ba-3", baStep: 3, baSubStep: "run-3" }),
    },
    {
      id: "ba-group-clean",
      targetId: "ba-group",
      glowColor: REPO_GLOW_DELIVERABLE,
      pillText: "Clean tab group",
      dwellSec: 1.95,
      moveSec: 0.54,
      clickAtSec: 0.7,
      side: -1,
      curvature: 0.15,
      onEnterState: (base) => ({ ...base, ...baseDone, act: "ba-3", baStep: 3, baSubStep: "run-3" }),
      onClickState: (base) => ({ ...base, ...baseDone, act: "ba-3", baStep: 3, baSubStep: "run-3" }),
    },
  ];
}

function getInstallSteps(): RoutineStep[] {
  return [
    {
      id: "install-copy",
      targetId: "install-copy",
      glowColor: REPO_GLOW_DELIVERABLE,
      pillText: "Copy setup command",
      dwellSec: 2.4,
      moveSec: 0.56,
      clickAtSec: 0.85,
      side: 1,
      curvature: 0.16,
      onEnterState: (base) => ({ ...base, act: "install", installReady: true }),
      onClickState: (base) => ({ ...base, act: "install", installReady: true }),
    },
  ];
}

function runStepLoop(
  stage: DemoStageId,
  variantKey: string,
  steps: RoutineStep[],
  clockSec: number
): FrameDirectorDirective {
  const totalDuration = steps.reduce((acc, s) => acc + s.dwellSec, 0) || 1;
  const localClock = Math.max(0, clockSec - stageEnterClock);
  const cycleIdx = Math.floor(localClock / totalDuration);
  const loopTime = localClock - cycleIdx * totalDuration;

  let acc = 0;
  let stepIdx = steps.length - 1;
  let stepStart = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const end = acc + steps[i].dwellSec;
    if (loopTime < end || i === steps.length - 1) {
      stepIdx = i;
      stepStart = acc;
      break;
    }
    acc = end;
  }

  const step = steps[stepIdx];
  const prevStep = steps[(stepIdx - 1 + steps.length) % steps.length];
  const tInStep = Math.max(0, loopTime - stepStart);

  const destAnchor =
    getAnchorPoint(step.targetId) ?? lastEmittedPoint ?? { x: window.innerWidth * 0.6, y: window.innerHeight * 0.45 };
  const isEntryTransition =
    cycleIdx === 0 && stepIdx === 0 && transitionFromPoint !== null && tInStep < stageTransitionSec;

  let targetPoint: Point = destAnchor;
  if (isEntryTransition && transitionFromPoint) {
    const u = easeInOutCubic(tInStep / stageTransitionSec);
    targetPoint = evaluateQuadraticArc(
      transitionFromPoint,
      destAnchor,
      u,
      0.22,
      step.side ?? 1
    ).point;
  } else {
    const moveSec = step.moveSec ?? 0.54;
    if (tInStep < moveSec && !(cycleIdx === 0 && stepIdx === 0 && steps.length > 1 && transitionFromPoint === null)) {
      const prevAnchor = getAnchorPoint(prevStep.targetId);
      if (prevAnchor) {
        const u = easeInOutCubic(tInStep / moveSec);
        targetPoint = evaluateQuadraticArc(
          prevAnchor,
          destAnchor,
          u,
          step.curvature ?? 0.16,
          step.side ?? 1
        ).point;
      }
    }
  }

  let clickKey: string | null = null;
  let clickTargetId: string | null = null;
  let clicked = false;
  let glowColor = step.glowColor;

  if (step.clickAtSec !== null && !isEntryTransition) {
    const minClickAt = Math.max(
      step.moveSec ?? 0.54,
      cycleIdx === 0 && stepIdx === 0 && transitionFromPoint ? stageTransitionSec + 0.08 : step.clickAtSec
    );
    const clickAt = Math.min(minClickAt, Math.max(0.2, step.dwellSec - 0.35));
    clicked = tInStep >= clickAt;
    if (clicked && tInStep <= clickAt + 0.36) {
      clickKey = `${stage}:${variantKey}:${step.id}:e${routineEpoch}:c${cycleIdx}`;
      clickTargetId = step.targetId;
    }
  }

  if (!clicked && stepIdx > 0) {
    glowColor = prevStep.glowColor;
  }

  const baseState: CursorChoreographyState = {
    ...DEFAULT_STATE,
    enabled: true,
    isolationStep: manualIsolationPicked ? currentState.isolationStep : DEFAULT_STATE.isolationStep,
    baStep: currentBeforeAfterStep,
  };
  const nextState =
    clicked && step.onClickState ? step.onClickState(baseState) : step.onEnterState(baseState);
  emitState(nextState);

  lastEmittedPoint = targetPoint;
  lastEmittedGlow = glowColor;

  return {
    targetPoint,
    visible: true,
    glowColor,
    pillText: step.pillText,
    wobble: Boolean(step.wobble) && !clicked,
    clickKey,
    clickTargetId,
  };
}

function evaluateTransitDirective(clockSec: number, vw: number, vh: number): FrameDirectorDirective {
  const localClock = Math.max(0, clockSec - stageEnterClock);

  let destPoint: Point = {
    x: vw * 0.86,
    y: clamp(vh * 0.44, 160, vh - 160),
  };
  let pillText = "";
  let activeClientIdx: number | null = null;
  let activeSpeedIdx: number | null = null;

  const drum = document.querySelector<HTMLElement>("#capabilities");
  const speed = document.querySelector<HTMLElement>("#speed");
  const clients = document.querySelector<HTMLElement>("#clients");

  if (getVisibleRatio(drum, vh) >= 0.45) {
    destPoint = getAnchorPoint("drum-detent") ?? destPoint;
    pillText = "Capabilities";
  } else if (getVisibleRatio(speed, vh) >= 0.45 && speed) {
    const items = speed.querySelectorAll<HTMLElement>(".speed-band__item");
    if (items.length > 0) {
      const idx = Math.floor(localClock / 1.4) % items.length;
      activeSpeedIdx = idx;
      const r = items[idx].getBoundingClientRect();
      destPoint = {
        x: clamp(r.right - 54, vw * 0.62, vw - 64),
        y: clamp(r.top + r.height * 0.5, 110, vh - 110),
      };
      pillText = "Speed benchmark";
    }
  } else if (getVisibleRatio(clients, vh) >= 0.45 && clients) {
    const items = clients.querySelectorAll<HTMLElement>(".clients-item");
    if (items.length > 0) {
      const idx = Math.floor(localClock / 1.1) % items.length;
      activeClientIdx = idx;
      const r = items[idx].getBoundingClientRect();
      destPoint = {
        x: clamp(r.left + r.width * 0.5, 80, vw - 80),
        y: clamp(r.bottom + 14, 100, vh - 80),
      };
      pillText = "Works in your agent";
    }
  }

  let targetPoint = destPoint;
  if (transitionFromPoint && localClock < stageTransitionSec) {
    const u = easeInOutCubic(localClock / stageTransitionSec);
    targetPoint = evaluateQuadraticArc(transitionFromPoint, destPoint, u, 0.2, 1).point;
  }

  emitState({
    ...DEFAULT_STATE,
    enabled: true,
    act: "transit",
    activeClientIdx,
    activeSpeedIdx,
  });

  lastEmittedPoint = targetPoint;
  lastEmittedGlow = REPO_GLOW_ACTIVE;

  return {
    targetPoint,
    visible: true,
    glowColor: REPO_GLOW_ACTIVE,
    pillText,
    wobble: true,
    clickKey: null,
    clickTargetId: null,
  };
}

export function evaluateCursorDirective(clockSec: number): FrameDirectorDirective {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return {
      targetPoint: null,
      visible: false,
      glowColor: REPO_GLOW_ACTIVE,
      pillText: "",
      wobble: false,
      clickKey: null,
      clickTargetId: null,
    };
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const stage = resolveStage(clockSec, vh);

  if (stage === "outro") {
    emitState({ ...DEFAULT_STATE, enabled: true, act: "outro" });
    return {
      targetPoint: lastEmittedPoint ?? { x: vw * 0.62, y: vh * 0.42 },
      visible: false,
      glowColor: lastEmittedGlow,
      pillText: "",
      wobble: false,
      clickKey: null,
      clickTargetId: null,
    };
  }

  switch (stage) {
    case "hero":
      return runStepLoop("hero", activeHeroTab, getHeroSteps(), clockSec);
    case "feat1":
      return runStepLoop("feat1", "default", getFeat1Steps(), clockSec);
    case "feat2":
      return runStepLoop("feat2", "default", getFeat2Steps(), clockSec);
    case "isolation":
      return runStepLoop("isolation", "default", getIsolationSteps(), clockSec);
    case "before-after":
      return runStepLoop("before-after", `step${currentBeforeAfterStep}`, getBeforeAfterSteps(), clockSec);
    case "install":
      return runStepLoop("install", "default", getInstallSteps(), clockSec);
    case "transit":
    default:
      return evaluateTransitDirective(clockSec, vw, vh);
  }
}
