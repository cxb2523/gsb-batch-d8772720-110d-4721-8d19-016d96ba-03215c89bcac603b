/**
 * axuse — AT-SPI2 client over the zero-dependency D-Bus transport.
 *
 * The macOS driver gets its platform AX tree from System Events; on Linux
 * the same tree lives at AT-SPI2, exposed over a private D-Bus socket. This
 * module speaks the AT-SPI interface set directly (verified against the
 * live at-spi2 registry on Xorg/GNOME, Ubuntu 22.04):
 *
 *   - objects are (bus name, object path) pairs — children of the desktop
 *     live on each application's own connection name
 *   - Accessible: GetChildren → a(so), GetChildAtIndex(i), GetRoleName,
 *     GetState → (au), GetInterfaces → as, GetApplication → (so);
 *     Name/ChildCount/Description are D-Bus PROPERTIES (the old GetX
 *     methods do not exist on current registries)
 *   - Component.GetExtents(coordType 0) → (iiii) screen-absolute bounds
 *   - Action: nActions property, GetActionName(i), DoAction(i)
 *   - Text: GetCharCount, GetText(start, end); EditableText.SetTextContents
 *   - Value: current/minimum/maximum as variants
 */
import { AxError, Codes } from "../core/errors.js";
import { DbusClient } from "./dbus.js";

const A11Y = "org.a11y.atspi.Accessible";
const REGISTRY_NAME = "org.a11y.atspi.Registry";
const DESKTOP_PATH = "/org/a11y/atspi/accessible/root";

/** AT-SPI state bits (atspi-state.h) — the operationally meaningful ones. */
export const STATE_NAMES = [
  "invalid", "active", "armed", "busy", "checked", "collapsed", "defunct",
  "editable", "enabled", "expandable", "expanded", "focusable", "focused",
  "has-tooltip", "horizontal", "iconified", "modal", "multi-line",
  "multiselectable", "opaque", "pressed", "resizable", "selectable",
  "selected", "sensitive", "showing", "single-line", "stale", "transient",
  "vertical", "visible", "manages-descendants", "indeterminate",
];

function decodeStates(words) {
  const out = [];
  for (let w = 0; w < words.length; w++) {
    let bits = words[w] >>> 0;
    let b = 0;
    while (bits) {
      if (bits & 1) {
        const name = STATE_NAMES[w * 32 + b];
        if (name) out.push(name);
      }
      bits >>>= 1;
      b++;
    }
  }
  return out;
}

export class AtspiClient {
  /** @param {{sessionBusAddress?: string}} [opts] — the session bus to
   *  discover org.a11y.Bus on (defaults to the ambient environment; the
   *  sandbox test passes a private bus explicitly). */
  constructor(opts = {}) {
    this.sessionBusAddress = opts.sessionBusAddress ?? process.env.DBUS_SESSION_BUS_ADDRESS;
    this.bus = null; // the AT-SPI bus connection
    this.sessionBus = null; // temporary connection used to discover it
  }

  /** Discover and connect the AT-SPI bus. */
  async connect() {
    const direct = process.env.AXUSE_ATSPI_BUS;
    let address = direct ?? null;
    if (!address) {
      const sessionAddress = this.sessionBusAddress;
      if (!sessionAddress) {
        throw new AxError(Codes.DESKTOP_DRIVER_UNAVAILABLE,
          "No D-Bus session bus (DBUS_SESSION_BUS_ADDRESS unset) — the AT-SPI structure layer needs the session's accessibility bus.",
          { hint: "Run inside the desktop session; structure-first desktop control needs AT-SPI.", retry: "never" });
      }
      try {
        this.sessionBus = await new DbusClient(sessionAddress).connect();
        const [a] = await this.sessionBus.call("org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress", "", []);
        address = String(a);
      } catch (e) {
        try { this.sessionBus?.close(); } catch {}
        this.sessionBus = null;
        throw new AxError(Codes.DESKTOP_DRIVER_UNAVAILABLE,
          `The session bus has no org.a11y.Bus (is at-spi2 running?): ${e.message}`,
          { hint: "Install/enable at-spi2-core; coordinate+vision tools keep working without it.", retry: "never" });
      }
    }
    try {
      this.bus = await new DbusClient(address).connect();
    } catch (e) {
      try { this.sessionBus?.close(); } catch {}
      this.sessionBus = null;
      throw e;
    }
    return this;
  }

  get connected() {
    return !!this.bus?.socket && !this.bus.dead;
  }

  close() {
    try { this.bus?.close(); } catch {}
    try { this.sessionBus?.close(); } catch {}
    this.bus = null;
    this.sessionBus = null;
  }

  /* ------------------------------------------------------ object helpers */

  /** The desktop root (registry-owned). */
  desktop() {
    return [REGISTRY_NAME, DESKTOP_PATH];
  }

  /** Accessible children as (name, path) pairs. */
  async children(ref) {
    const [list] = await this.bus.call(ref[0], ref[1], A11Y, "GetChildren", "", []);
    return list;
  }

  async childCount(ref) {
    const v = await this.bus.prop(ref[0], ref[1], A11Y, "ChildCount");
    return Number(v);
  }

  async name(ref) {
    const v = await this.bus.prop(ref[0], ref[1], A11Y, "Name");
    return String(v ?? "");
  }

  async description(ref) {
    const v = await this.bus.prop(ref[0], ref[1], A11Y, "Description");
    return String(v ?? "");
  }

  async role(ref) {
    // Method on most at-spi2 apps; a few roots only expose the Role
    // property (role enum) — report it honestly as role#N then.
    try {
      const [r] = await this.bus.call(ref[0], ref[1], A11Y, "GetRoleName", "", []);
      return String(r);
    } catch {
      const v = await this.bus.prop(ref[0], ref[1], A11Y, "Role").catch(() => null);
      return v === null ? "unknown" : `role#${Number(v)}`;
    }
  }

  async states(ref) {
    const [words] = await this.bus.call(ref[0], ref[1], A11Y, "GetState", "", []);
    return decodeStates(Array.isArray(words) ? words : [words]);
  }

  async interfaces(ref) {
    const [list] = await this.bus.call(ref[0], ref[1], A11Y, "GetInterfaces", "", []);
    return list;
  }

  async application(ref) {
    const [app] = await this.bus.call(ref[0], ref[1], A11Y, "GetApplication", "", []);
    return app;
  }

  /** Screen-absolute bounds via Component.GetExtents(coordType 0). */
  async bounds(ref) {
    const [tuple] = await this.bus.call(ref[0], ref[1], "org.a11y.atspi.Component", "GetExtents", "u", [0]);
    return { x: tuple[0], y: tuple[1], w: tuple[2], h: tuple[3] };
  }

  /* --------------------------------------------------------------- Action */
  // CAUTION: GetActions is never called internally — GTK's atk-bridge (2.4x)
  // crashes marshalling its a(sss) reply and takes the app's bus connection
  // with it. DoAction(i) and GetActionName(i) are the safe surface.

  async actionCount(ref) {
    try {
      const v = await this.bus.prop(ref[0], ref[1], "org.a11y.atspi.Action", "nActions");
      if (v !== undefined && v !== null) return Number(v);
    } catch {}
    // No nActions property (GTK): a resolvable action name implies ≥1 action.
    try { await this.actionName(ref, 0); return 1; } catch { return 0; }
  }

  async actionName(ref, index) {
    const [n] = await this.bus.call(ref[0], ref[1], "org.a11y.atspi.Action", "GetActionName", "i", [index]);
    return String(n);
  }

  async doAction(ref, index) {
    const [ok] = await this.bus.call(ref[0], ref[1], "org.a11y.atspi.Action", "DoAction", "i", [index]);
    return !!ok;
  }

  async doAction(ref, index) {
    const [ok] = await this.bus.call(ref[0], ref[1], "org.a11y.atspi.Action", "DoAction", "i", [index]);
    return !!ok;
  }

  /* ----------------------------------------------------------------- Text */

  async charCount(ref) {
    const [n] = await this.bus.call(ref[0], ref[1], "org.a11y.atspi.Text", "GetCharCount", "", []);
    return Number(n);
  }

  async text(ref, start = 0, end = -1) {
    const [s] = await this.bus.call(ref[0], ref[1], "org.a11y.atspi.Text", "GetText", "ii", [start, end]);
    return String(s);
  }

  async setTextContents(ref, contents) {
    const [ok] = await this.bus.call(ref[0], ref[1], "org.a11y.atspi.EditableText", "SetTextContents", "s", [String(contents)]);
    return !!ok;
  }

  /* ---------------------------------------------------------------- Value */

  async value(ref) {
    try {
      const [cur] = await this.bus.call(ref[0], ref[1], "org.a11y.atspi.Value", "GetCurrentValue", "", []);
      return cur?.sig === "d" ? cur.value : cur?.value ?? null;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------- registry */

  /** Applications registered on the desktop: [{ref, name}]. */
  async apps() {
    const kids = await this.children(this.desktop());
    const out = [];
    for (const ref of kids) {
      let n = "";
      try { n = await this.name(ref); } catch {}
      out.push({ ref, name: n });
    }
    return out;
  }
}
