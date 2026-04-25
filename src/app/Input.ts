// Lightweight input state. Read each frame by Game.

export interface LmbHold {
  /** Pixel coords where LMB was first pressed. */
  startX: number;
  startY: number;
  /** Pixel coords of the cursor right now. */
  currentX: number;
  currentY: number;
  /** Was shift held when LMB went down? */
  shift: boolean;
}

export interface LmbRelease {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  shift: boolean;
}

export class Input {
  readonly keys = new Set<string>();
  mouseX = -1;
  mouseY = -1;
  rmbDown = false;
  rmbDx = 0;
  rmbDy = 0;
  private rmbAccDx = 0;
  private rmbAccDy = 0;
  wheel = 0;
  private wheelAcc = 0;

  /** Active hold (truthy while LMB is currently down). */
  hold: LmbHold | null = null;
  /** A click-release event pending for this frame; cleared in beginFrame. */
  release: LmbRelease | null = null;
  private holdInternal: LmbHold | null = null;
  private releaseQueued: LmbRelease | null = null;

  /** Single-frame "key just pressed" pulses for hotkeys. */
  private pressedQueue = new Set<string>();
  pressed = new Set<string>();

  attach(el: HTMLElement | Window): void {
    el.addEventListener('keydown', (e: Event) => {
      const ke = e as KeyboardEvent;
      if (!this.keys.has(ke.code)) this.pressedQueue.add(ke.code);
      this.keys.add(ke.code);
      if (ke.code === 'Tab') ke.preventDefault();
    });
    el.addEventListener('keyup', (e: Event) => { this.keys.delete((e as KeyboardEvent).code); });
    el.addEventListener('mousemove', (e: Event) => {
      const me = e as MouseEvent;
      this.mouseX = me.clientX;
      this.mouseY = me.clientY;
      if (this.rmbDown) { this.rmbAccDx += me.movementX; this.rmbAccDy += me.movementY; }
      if (this.holdInternal) {
        this.holdInternal.currentX = me.clientX;
        this.holdInternal.currentY = me.clientY;
      }
    });
    el.addEventListener('mousedown', (e: Event) => {
      const me = e as MouseEvent;
      if (me.button === 2) { this.rmbDown = true; me.preventDefault(); }
      if (me.button === 0) {
        this.holdInternal = {
          startX: me.clientX, startY: me.clientY,
          currentX: me.clientX, currentY: me.clientY,
          shift: me.shiftKey,
        };
      }
    });
    el.addEventListener('mouseup', (e: Event) => {
      const me = e as MouseEvent;
      if (me.button === 2) this.rmbDown = false;
      if (me.button === 0 && this.holdInternal) {
        this.releaseQueued = {
          startX: this.holdInternal.startX, startY: this.holdInternal.startY,
          endX: me.clientX, endY: me.clientY,
          shift: this.holdInternal.shift,
        };
        this.holdInternal = null;
      }
    });
    el.addEventListener('contextmenu', (e: Event) => { e.preventDefault(); });
    el.addEventListener('wheel', (e: Event) => {
      this.wheelAcc += (e as WheelEvent).deltaY;
      e.preventDefault();
    }, { passive: false } as AddEventListenerOptions);
    el.addEventListener('blur', () => {
      this.keys.clear();
      this.holdInternal = null;
    });
  }

  beginFrame(): void {
    this.rmbDx = this.rmbAccDx;
    this.rmbDy = this.rmbAccDy;
    this.rmbAccDx = 0;
    this.rmbAccDy = 0;
    this.wheel = this.wheelAcc;
    this.wheelAcc = 0;
    this.hold = this.holdInternal ? { ...this.holdInternal } : null;
    this.release = this.releaseQueued;
    this.releaseQueued = null;
    this.pressed = this.pressedQueue;
    this.pressedQueue = new Set<string>();
  }
}
