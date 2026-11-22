export interface CopyResult {
  ok: boolean;
  text: string;
}

let lastAnnouncement = "";

function legacyCopy(text: string): boolean {
  const field = Object.assign(document.createElement("textarea"), { value: text });
  field.setAttribute("readonly", "");
  field.style.cssText = "position:fixed;inset-block-start:0;opacity:0;pointer-events:none;";
  document.body.append(field);
  field.select();
  try {
    return document.execCommand("copy");
  } finally {
    field.remove();
  }
}

export async function performCopy(button: HTMLButtonElement, target: HTMLElement): Promise<void> {
  const raw =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? target.value
      : target.dataset.copyValue ?? target.innerText.replace(/^\$\s*/, "");
  const text = raw.trim();
  if (!text) return;

  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    } else {
      ok = legacyCopy(text);
    }
  } catch {
    ok = legacyCopy(text);
  }

  button.dataset.copied = ok ? "true" : "false";

  const statusId = button.getAttribute("aria-describedby");
  const statusEl =
    (statusId ? document.getElementById(statusId) : null) ??
    button.parentElement?.querySelector<HTMLElement>('[role="status"]');

  if (statusEl) {
    let msg = ok ? "Copied command to clipboard" : "Copy failed, select text to copy";
    if (msg === lastAnnouncement) {
      msg += "\u00A0";
    }
    lastAnnouncement = msg;
    statusEl.textContent = msg;
  }

  const prevTimer = Number(button.dataset.copyTimer || "0");
  if (prevTimer) window.clearTimeout(prevTimer);
  const timer = window.setTimeout(() => {
    delete button.dataset.copied;
    if (statusEl) statusEl.textContent = "";
  }, 1800);
  button.dataset.copyTimer = String(timer);
}

interface InvokerCommandEvent extends Event {
  readonly command: string;
  readonly source: Element | null;
}

/**
 * Registers one document-level copy delegation listener.
 * Guards against double-firing when Invoker Commands (`CommandEvent`) are native.
 */
export function initCopyCommands(): () => void {
  const handle = (event: Event) => {
    if ("CommandEvent" in window && event.type === "command") {
      const cmdEvent = event as InvokerCommandEvent;
      if (cmdEvent.command !== "--copy") return;
      const source = cmdEvent.source;
      const target = cmdEvent.target;
      if (source instanceof HTMLButtonElement && target instanceof HTMLElement) {
        void performCopy(source, target);
      }
      return;
    }

    const clickTarget = event.target;
    if (!(clickTarget instanceof Element)) return;
    const button = clickTarget.closest<HTMLButtonElement>('button[command="--copy"]');
    if (!button) return;
    const forId = button.getAttribute("commandfor");
    if (!forId) return;
    const target = document.getElementById(forId);
    if (target) {
      void performCopy(button, target);
    }
  };

  if ("CommandEvent" in window) {
    document.addEventListener("command", handle, { capture: true });
    return () => document.removeEventListener("command", handle, { capture: true });
  }

  document.addEventListener("click", handle);
  return () => document.removeEventListener("click", handle);
}
