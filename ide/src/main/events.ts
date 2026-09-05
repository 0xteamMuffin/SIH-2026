import type { WebContents } from "electron";

import { MAIN_EVENT_CHANNEL, type MainEvent } from "@shared/ipc.js";

/**
 * Pushes main → renderer events over the single shared event channel.
 *
 * The target is set after the window exists and cleared when it is destroyed,
 * so services can hold a broadcaster reference for their whole lifetime and
 * emit freely — sends that arrive with no live window are dropped instead of
 * throwing on a destroyed `WebContents`.
 */
export class EventBroadcaster {
  #target: WebContents | null = null;

  setTarget(target: WebContents): void {
    this.#target = target;
    target.once("destroyed", () => {
      if (this.#target === target) this.#target = null;
    });
  }

  emit(event: MainEvent): void {
    if (!this.#target || this.#target.isDestroyed()) return;
    this.#target.send(MAIN_EVENT_CHANNEL, event);
  }
}
