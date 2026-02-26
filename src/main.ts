#!/usr/bin/env bun
/**
 * NixOS TUI — Settings & Tutorial System  (v3)
 * Keys: ↑↓ navigate · Enter select · Tab switch pane · q back · ? help
 *
 * v3 additions:
 *  - Sierpinski triangle on home screen, depth driven by logical CPU thread count
 *    (more cores → deeper fractal → visible hardware parallelism)
 *  - Half-block (▀▄█) rendering for 2× vertical resolution
 *  - Per-level color gradient across the fractal
 *
 * v2 fixes (retained):
 *  - cycleSettingBack() wired to left-arrow on enum/number settings
 *  - Status timer properly replaced (no stacked timeouts)
 *  - Escape key disambiguated from arrow-key prefix
 *  - Export screen: ↑↓/PgUp/PgDn scrolling + g/G jump + line numbers
 *  - String/number inline editing with cursor navigation
 *  - Modified-vs-default indicator (◈) + section badges
 *  - Save-to-disk (W key) from export screen
 *  - Minimum terminal size guard (80×24)
 *  - Ctrl+C handled in all modes
 *  - Tutorial code block off-by-one fixed
 *  - Sidebar overflow guard
 *  - Home banner clamped to terminal width
 *  - User section with editable string fields
 *  - Richer config generation (SSH port, security, NUR notes, etc.)
 *  - Config result cached; invalidated on each settings change
 *  - adjustSetting bool is directional (right=on, left=off)
 *  - greetd uses services.greetd (not xserver.displayManager)
 *  - hyprland/sway/river use programs.* (not windowManager)
 *  - auto-optimise-store emitted via nix.optimise.automatic (gated)
 *  - homeManager + wayland toggles wired into config output
 *  - box() title centering uses visLen() (emoji-safe)
 *  - hostname + username validation in commitEdit()
 *  - Tutorial completion tracked + shown (✓) in list
 *  - Tab on export → jumps to Settings
 *  - cleanup() called once (no double-fire on SIGINT)
 *  - R key resets current settings section to defaults
 */

// ─── System info ─────────────────────────────────────────────────────────────

function getLogicalThreads(): number {
  try {
    // Bun exposes navigator.hardwareConcurrency; Node has os.cpus()
    if (typeof navigator !== "undefined" && navigator.hardwareConcurrency > 0)
      return navigator.hardwareConcurrency;
    const os = require("os") as { cpus: () => unknown[] };
    return Math.max(1, os.cpus().length);
  } catch {
    return 1;
  }
}

const CPU_THREADS = getLogicalThreads();

// ─── ANSI / Terminal Primitives ─────────────────────────────────────────────

const ESC = "\x1b";
const CSI = `${ESC}[`;

const T = {
  clear:      () => `${CSI}2J${CSI}H`,
  pos:        (r: number, c: number) => `${CSI}${r};${c}H`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  altOn:      `${ESC}[?1049h`,
  altOff:     `${ESC}[?1049l`,
  reset:      `${CSI}0m`,
  bold:       `${CSI}1m`,
  dim:        `${CSI}2m`,
  reverse:    `${CSI}7m`,
  fg: (r: number, g: number, b: number) => `${CSI}38;2;${r};${g};${b}m`,
  bg: (r: number, g: number, b: number) => `${CSI}48;2;${r};${g};${b}m`,
};

// ─── Palette ─────────────────────────────────────────────────────────────────

const P = {
  bg:      [13,  17,  23 ] as const,
  panel:   [20,  27,  38 ] as const,
  border:  [40,  80,  120] as const,
  accent:  [82,  182, 255] as const,
  alt:     [100, 240, 180] as const,
  warn:    [255, 180, 60 ] as const,
  err:     [255, 80,  80 ] as const,
  muted:   [70,  95,  130] as const,
  text:    [200, 215, 235] as const,
  bright:  [240, 248, 255] as const,
  sel:     [28,  58,  100] as const,
  selText: [160, 225, 255] as const,
  mod:     [255, 210, 90 ] as const,
  inputBg: [18,  30,  50 ] as const,
};

type RGB = readonly [number, number, number];
const fg  = (p: RGB) => T.fg(...p);
const bg  = (p: RGB) => T.bg(...p);
const rst = T.reset;

// ─── Box-drawing ──────────────────────────────────────────────────────────────

const B = {
  tl:"╭", tr:"╮", bl:"╰", br:"╯", h:"─", v:"│",
  dh:"═", dv:"║", dtl:"╔", dtr:"╗", dbl:"╚", dbr:"╝",
  arr:"›", bullet:"◆", check:"✓", cross:"✗", pencil:"✎",
  bar:"█", barL:"░",
  moddot:"◈", dot:"◇",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const write = (s: string) => process.stdout.write(s);

function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*[mGKHJABCDsu]/g, "").replace(/[^\x00-\x7F]/g, "XX").length;
}

function padStr(s: string, w: number, align: "left"|"right"|"center" = "left"): string {
  const sp = Math.max(0, w - visLen(s));
  if (align === "right")  return " ".repeat(sp) + s;
  if (align === "center") { const l = Math.floor(sp/2); return " ".repeat(l) + s + " ".repeat(sp-l); }
  return s + " ".repeat(sp);
}

function clip(s: string, w: number): string {
  return visLen(s) <= w ? s : s.slice(0, w - 1) + "…";
}

function box(
  row: number, col: number, w: number, h: number,
  title = "", style: "single"|"double"|"accent" = "single",
  focused = false
): string {
  const bc = focused ? fg(P.accent) : style === "accent" ? fg(P.alt) : fg(P.border);
  const hl = style === "double" ? B.dh : B.h;
  const vl = style === "double" ? B.dv : B.v;
  const [ctl, ctr, cbl, cbr] = style === "double"
    ? [B.dtl, B.dtr, B.dbl, B.dbr] : [B.tl, B.tr, B.bl, B.br];

  let out = bg(P.panel) + bc;
  out += T.pos(row, col) + ctl;
  if (title) {
    const raw   = title.replace(/\x1b\[[0-9;]*m/g, "");
    const space = Math.max(0, w - 2 - visLen(raw) - 2);
    const lp    = Math.floor(space / 2);
    out += hl.repeat(lp) + " "
      + rst + T.bold + (focused ? fg(P.accent) : fg(P.bright)) + bg(P.panel)
      + title + rst + bg(P.panel) + bc
      + " " + hl.repeat(space - lp);
  } else {
    out += hl.repeat(w - 2);
  }
  out += ctr;
  for (let r = 1; r < h - 1; r++) {
    out += T.pos(row + r, col) + bc + vl + bg(P.panel) + " ".repeat(w - 2) + bc + vl;
  }
  out += T.pos(row + h - 1, col) + cbl + hl.repeat(w - 2) + cbr + rst;
  return out;
}

// ─── Sierpinski Fractal ───────────────────────────────────────────────────────
//
// Depth is driven by CPU thread count, clamped to available terminal space.
//
// Math: the Sierpinski triangle is Pascal's triangle mod 2.
// Cell (logRow, k) in the triangular grid is filled iff C(logRow, k) is odd,
// which holds exactly when (logRow & k) === k  (no carries in binary addition).
//
// For rendering, we convert from an absolute column coordinate (0..2*size-2,
// centred on size-1) back to the Pascal column k, then apply the bit test.
//
// Half-block characters (▀ ▄ █) double the vertical resolution: each terminal
// row encodes two logical pixel rows as foreground/background colours.

function sierpinskiDepth(cpuCount: number, availRows: number, availCols: number): number {
  // Map CPU count to a raw depth: 1-2→2, 3-4→2, 5-8→3, 9-16→4, 17-32→5, 33+→6
  const cpuDepth = Math.min(6, Math.max(2, Math.ceil(Math.log2(Math.max(cpuCount, 2)))));
  let depth = cpuDepth;
  while (depth > 1) {
    const size     = 1 << depth;
    const termRows = Math.ceil(size / 2); // half-block: 2 logical rows per terminal row
    const termCols = 2 * size - 1;
    if (termRows <= availRows && termCols <= availCols) break;
    depth--;
  }
  return Math.max(1, depth);
}

/**
 * Returns true if the cell at absolute coordinates (logRow, absCol) within
 * a triangle of the given size should be filled.
 * logRow: 0 = apex, size-1 = base.
 * absCol: 0..(2*size-2), centred on (size-1).
 */
function sierpinskiFilled(logRow: number, absCol: number, size: number): boolean {
  const offset = absCol - (size - 1 - logRow); // col offset from this row's left edge
  if (offset < 0 || offset > 2 * logRow || offset % 2 !== 0) return false;
  const k = offset >> 1;                         // Pascal triangle column
  return (logRow & k) === k;                     // C(logRow, k) odd?
}

/**
 * Interpolate a colour for a given fractional position (0→top, 1→base).
 * Gradient: accent-blue → alt-green → warm-amber at the edges for depth marker.
 */
function fractalColor(t: number): [number, number, number] {
  // blue (82,182,255) → green (100,240,180) → amber (255,180,60)
  if (t < 0.5) {
    const s = t * 2;
    return [
      Math.round(82  + s * (100 - 82)),
      Math.round(182 + s * (240 - 182)),
      Math.round(255 + s * (180 - 255)),
    ];
  } else {
    const s = (t - 0.5) * 2;
    return [
      Math.round(100 + s * (255 - 100)),
      Math.round(240 + s * (180 - 240)),
      Math.round(180 + s * (60  - 180)),
    ];
  }
}

/**
 * Render the Sierpinski triangle using half-block characters for 2× vertical
 * resolution. Returns an ANSI string to be written to the terminal.
 *
 * @param termRow  Top terminal row (1-indexed)
 * @param termColCenter  Column of the triangle's centre (1-indexed)
 * @param depth    Recursion depth
 */
function renderSierpinski(termRow: number, termColCenter: number, depth: number): string {
  const size     = 1 << depth;                // 2^depth logical rows
  const termRows = Math.ceil(size / 2);       // terminal rows needed
  const width    = 2 * size - 1;             // character columns
  const colStart = termColCenter - (size - 1);

  let out = "";

  for (let tr = 0; tr < termRows; tr++) {
    const lr0 = tr * 2;           // logical row for top half-block
    const lr1 = tr * 2 + 1;      // logical row for bottom half-block

    out += T.pos(termRow + tr, colStart) + bg(P.bg);

    for (let lc = 0; lc < width; lc++) {
      const topFilled = lr0 < size && sierpinskiFilled(lr0, lc, size);
      const botFilled = lr1 < size && sierpinskiFilled(lr1, lc, size);

      if (!topFilled && !botFilled) {
        out += " ";
        continue;
      }

      // Colour: gradient from apex (t=0) to base (t=1)
      const tTop = lr0 / (size - 1);
      const tBot = Math.min(1, lr1 / (size - 1));
      const cTop = fractalColor(tTop);
      const cBot = fractalColor(tBot);

      if (topFilled && botFilled) {
        // Use ▀ with top=fg, bot=bg so both halves get their own colour
        out += T.fg(...cTop) + T.bg(...cBot) + "▀" + rst + bg(P.bg);
      } else if (topFilled) {
        out += T.fg(...cTop) + bg(P.bg) + "▀" + rst;
      } else {
        out += T.fg(...cBot) + bg(P.bg) + "▄" + rst;
      }
    }
  }

  return out + rst;
}

// ─── Data ─────────────────────────────────────────────────────────────────────

type SettingValue = boolean | string | number;

interface Setting {
  key: string;
  label: string;
  type: "bool" | "string" | "enum" | "number";
  value: SettingValue;
  options?: string[];
  min?: number; max?: number;
  description: string;
  placeholder?: string;
}

interface SettingsSection {
  id: string; icon: string; label: string;
  settings: Setting[];
}

const SETTINGS: SettingsSection[] = [
  {
    id: "user", icon: "👤", label: "User",
    settings: [
      { key:"username",    label:"Username",        type:"string", value:"alice",
        placeholder:"e.g. alice",       description:"Primary user account (users.users.<n>)" },
      { key:"fullName",    label:"Full Name",        type:"string", value:"Alice",
        placeholder:"e.g. Alice Smith", description:"users.users.<n>.description" },
      { key:"shell",       label:"Default Shell",   type:"enum",   value:"bash",
        options:["bash","zsh","fish","nushell","elvish"], description:"users.users.<n>.shell = pkgs.<shell>" },
      { key:"homeManager", label:"Home Manager",    type:"bool",   value:false,
        description:"Enable nix-community/home-manager NixOS module" },
      { key:"autologin",   label:"Auto Login",      type:"bool",   value:false,
        description:"services.displayManager.autoLogin.enable" },
    ]
  },
  {
    id: "system", icon: "⚙", label: "System",
    settings: [
      { key:"hostname",    label:"Hostname",         type:"string", value:"nixos",
        placeholder:"e.g. mymachine", description:"networking.hostName" },
      { key:"timezone",    label:"Time Zone",        type:"enum",   value:"UTC",
        options:["UTC","America/New_York","America/Chicago","America/Los_Angeles","America/Denver",
                 "Europe/London","Europe/Berlin","Europe/Paris","Asia/Tokyo","Asia/Singapore","Australia/Sydney"],
        description:"time.timeZone" },
      { key:"locale",      label:"Locale",           type:"enum",   value:"en_US.UTF-8",
        options:["en_US.UTF-8","en_GB.UTF-8","de_DE.UTF-8","fr_FR.UTF-8","es_ES.UTF-8","ja_JP.UTF-8"],
        description:"i18n.defaultLocale" },
      { key:"flakes",      label:"Enable Flakes",    type:"bool",   value:true,
        description:'nix.settings.experimental-features = [ "nix-command" "flakes" ]' },
      { key:"gc",          label:"Auto GC",          type:"bool",   value:true,
        description:"nix.gc.automatic — weekly garbage collection" },
      { key:"gcDays",      label:"GC Keep Days",     type:"number", value:30,  min:1,  max:365,
        description:"nix.gc.options --delete-older-than Nd" },
      { key:"autoUpgrade", label:"Auto Upgrade",     type:"bool",   value:false,
        description:"system.autoUpgrade.enable" },
      { key:"optimize",    label:"Store Optimise",   type:"bool",   value:true,
        description:"nix.optimise.automatic — deduplicates the store with hard-links" },
      { key:"stateVersion", label:"State Version",   type:"enum",   value:"24.11",
        options:["24.05","24.11","25.05"],
        description:"system.stateVersion — set once at install, never change" },
    ]
  },
  {
    id: "desktop", icon: "🖥", label: "Desktop",
    settings: [
      { key:"de",          label:"Desktop / WM",     type:"enum",   value:"plasma6",
        options:["gnome","plasma6","xfce","i3","sway","hyprland","river","none"],
        description:"gnome/plasma6/xfce → desktopManager; i3 → windowManager; sway/hyprland → programs.*" },
      { key:"dm",          label:"Display Manager",  type:"enum",   value:"sddm",
        options:["gdm","sddm","lightdm","greetd","none"],
        description:"gdm/sddm/lightdm → services.xserver.displayManager; greetd → services.greetd" },
      { key:"wayland",     label:"Wayland",          type:"bool",   value:true,
        description:"Prefer Wayland session where available" },
      { key:"pipewire",    label:"PipeWire",         type:"bool",   value:true,
        description:"services.pipewire.enable + disable pulseaudio" },
      { key:"bluetooth",   label:"Bluetooth",        type:"bool",   value:false,
        description:"hardware.bluetooth.enable" },
      { key:"printing",    label:"CUPS Printing",    type:"bool",   value:false,
        description:"services.printing.enable" },
      { key:"dpi",         label:"Screen DPI",       type:"number", value:96, min:72, max:300,
        description:"services.xserver.dpi (96=1×, 144=1.5×, 192=2×)" },
    ]
  },
  {
    id: "network", icon: "🌐", label: "Network",
    settings: [
      { key:"networkmanager", label:"NetworkManager",    type:"bool",   value:true,
        description:"networking.networkmanager.enable" },
      { key:"firewall",       label:"Firewall",          type:"bool",   value:true,
        description:"networking.firewall.enable" },
      { key:"ssh",            label:"SSH Server",        type:"bool",   value:false,
        description:"services.openssh.enable" },
      { key:"sshPwAuth",      label:"SSH Password Auth", type:"bool",   value:false,
        description:"services.openssh.settings.PasswordAuthentication" },
      { key:"sshPort",        label:"SSH Port",          type:"number", value:22, min:1, max:65535,
        description:"services.openssh.ports = [ N ]" },
      { key:"dns",            label:"DNS Resolver",      type:"enum",   value:"resolved",
        options:["resolved","dnsmasq","unbound","none"],
        description:"systemd-resolved / dnsmasq / unbound" },
      { key:"ipv6",           label:"IPv6",              type:"bool",   value:true,
        description:"networking.enableIPv6" },
      { key:"tailscale",      label:"Tailscale",         type:"bool",   value:false,
        description:"services.tailscale.enable" },
    ]
  },
  {
    id: "security", icon: "🔒", label: "Security",
    settings: [
      { key:"sudo",       label:"Sudo",              type:"bool",   value:true,
        description:"security.sudo.enable" },
      { key:"sudoWheel",  label:"Wheel Needs PW",    type:"bool",   value:true,
        description:"security.sudo.wheelNeedsPassword" },
      { key:"apparmor",   label:"AppArmor",          type:"bool",   value:false,
        description:"security.apparmor.enable" },
      { key:"tpm",        label:"TPM2",              type:"bool",   value:false,
        description:"security.tpm2.enable" },
      { key:"secureBoot", label:"Secure Boot",       type:"bool",   value:false,
        description:"boot.loader.systemd-boot.secureBoot (needs lanzaboote)" },
      { key:"aslr",       label:"Full ASLR",         type:"bool",   value:true,
        description:'boot.kernel.sysctl."kernel.randomize_va_space" = 2' },
      { key:"polkit",     label:"Polkit",            type:"bool",   value:true,
        description:"security.polkit.enable" },
    ]
  },
  {
    id: "packages", icon: "📦", label: "Packages",
    settings: [
      { key:"unfree",  label:"Allow Unfree",    type:"bool",   value:false,
        description:"nixpkgs.config.allowUnfree = true" },
      { key:"nix-ld",  label:"nix-ld",          type:"bool",   value:false,
        description:"programs.nix-ld.enable — run unpatched ELF binaries" },
      { key:"flatpak", label:"Flatpak",          type:"bool",   value:false,
        description:"services.flatpak.enable" },
      { key:"cachix",  label:"Cachix",           type:"bool",   value:false,
        description:"nix.settings.substituters += cachix.cachix.org" },
      { key:"nur",     label:"NUR Overlay",      type:"bool",   value:false,
        description:"Nix User Repository overlay (add nur flake input)" },
      { key:"channel", label:"Nixpkgs Channel",  type:"enum",   value:"nixos-unstable",
        options:["nixos-24.11","nixos-25.05","nixos-unstable","nixos-unstable-small"],
        description:"Flake input URL / nix-channel target" },
    ]
  },
];

// ─── Tutorials ────────────────────────────────────────────────────────────────

interface TutorialStep {
  title: string;
  body: string[];
  code?: string;
  tip?: string;
}

interface Tutorial {
  id: string; icon: string; label: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  steps: TutorialStep[];
}

const TUTORIALS: Tutorial[] = [
  {
    id:"first-boot", icon:"🚀", label:"First Boot Checklist", difficulty:"beginner",
    steps:[
      {
        title:"Welcome to NixOS",
        body:[
          "NixOS is a declarative, reproducible Linux distro.",
          "Your entire system is described in /etc/nixos/configuration.nix",
          "or flake.nix — version-controllable and rollback-safe.",
          "",
          "This TUI lets you configure settings and preview the",
          "generated configuration.nix before applying it.",
        ],
        tip:"Use Settings to configure, Export → W to save, then nixos-rebuild switch.",
      },
      {
        title:"Set Hostname & Timezone",
        body:["Edit /etc/nixos/configuration.nix:"],
        code:`networking.hostName = "mymachine";
time.timeZone = "America/New_York";
i18n.defaultLocale = "en_US.UTF-8";`,
        tip:"Apply with: sudo nixos-rebuild switch",
      },
      {
        title:"Create a User Account",
        body:["Add a non-root user with sudo (wheel) access:"],
        code:`users.users.alice = {
  isNormalUser = true;
  extraGroups  = [ "wheel" "networkmanager" "audio" "video" ];
  initialPassword = "changeme"; # change immediately!
};`,
        tip:"Run passwd alice after first login to set a real password.",
      },
      {
        title:"Enable Networking",
        body:["NetworkManager is the easiest option:"],
        code:`networking.networkmanager.enable = true;
# Your user needs to be in the networkmanager group`,
        tip:"For Wi-Fi in a terminal: nmtui",
      },
      {
        title:"Install Packages",
        body:["Add packages to environment.systemPackages:"],
        code:`environment.systemPackages = with pkgs; [
  vim git curl wget htop bat eza
  # set nixpkgs.config.allowUnfree = true for proprietary packages
];`,
        tip:"Search: nix search nixpkgs <n>  or  search.nixos.org",
      },
      {
        title:"Rebuild & Rollback",
        body:["Commands you'll use every day:"],
        code:`sudo nixos-rebuild switch           # apply immediately
sudo nixos-rebuild switch --upgrade  # apply + upgrade
sudo nixos-rebuild boot              # apply at next reboot
sudo nixos-rebuild test              # apply, no boot entry
sudo nixos-rebuild switch --rollback # undo last switch`,
        tip:"Every rebuild creates a generation. Pick any from the boot menu.",
      },
    ]
  },
  {
    id:"flakes", icon:"❄", label:"Flakes Crash Course", difficulty:"intermediate",
    steps:[
      {
        title:"What is a Flake?",
        body:[
          "Flakes replace channels with a locked dependency graph.",
          "flake.lock pins every input — commit it to git and every",
          "machine builds identically from the same sources.",
          "",
          "Enable flakes first in your config:",
        ],
        code:`nix.settings.experimental-features = [ "nix-command" "flakes" ];`,
        tip:"After rebuilding, all nix and nixos-rebuild commands gain flake support.",
      },
      {
        title:"Minimal flake.nix",
        body:["Place in /etc/nixos/ alongside configuration.nix:"],
        code:`{
  description = "My NixOS config";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }: {
    nixosConfigurations.hostname = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [ ./configuration.nix ];
    };
  };
}`,
        tip:"Replace 'hostname' with your actual machine hostname.",
      },
      {
        title:"Rebuild with Flakes",
        body:[],
        code:`# From /etc/nixos
sudo nixos-rebuild switch --flake .#hostname

# From anywhere
sudo nixos-rebuild switch --flake /etc/nixos#hostname`,
        tip:"The #hostname part matches your nixosConfigurations attribute name.",
      },
      {
        title:"Managing Inputs",
        body:[],
        code:`nix flake update                        # update all inputs
nix flake lock --update-input nixpkgs   # update one
nix flake show                          # list all outputs
nix flake metadata                      # show locked versions`,
        tip:"Always commit flake.lock to git — it's your reproducibility guarantee.",
      },
      {
        title:"Add Home Manager",
        body:["Add as a flake input:"],
        code:`inputs = {
  nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  home-manager = {
    url = "github:nix-community/home-manager";
    inputs.nixpkgs.follows = "nixpkgs"; # share nixpkgs
  };
};

# In outputs modules list:
modules = [
  ./configuration.nix
  inputs.home-manager.nixosModules.home-manager
  {
    home-manager.useGlobalPkgs = true;
    home-manager.users.alice   = import ./home.nix;
  }
];`,
        tip:"useGlobalPkgs prevents duplicate nixpkgs instances.",
      },
    ]
  },
  {
    id:"home-manager", icon:"🏠", label:"Home Manager Setup", difficulty:"intermediate",
    steps:[
      {
        title:"What is Home Manager?",
        body:[
          "Manages your user environment the Nix way: dotfiles,",
          "user packages, shell config, fonts, GTK themes, services.",
          "All declarative — rollback-safe with its own generations.",
        ],
        tip:"Docs: nix-community.github.io/home-manager/",
      },
      {
        title:"Basic home.nix",
        body:[],
        code:`{ pkgs, ... }: {
  home.username      = "alice";
  home.homeDirectory = "/home/alice";
  home.stateVersion  = "24.11"; # set once, never change

  home.packages = with pkgs; [ ripgrep fd bat eza fzf delta ];

  programs.git = {
    enable    = true;
    userName  = "Alice";
    userEmail = "alice@example.com";
    delta.enable = true;
  };
}`,
        tip:"stateVersion controls state migration paths — set it once and leave it.",
      },
      {
        title:"Shell Configuration",
        body:[],
        code:`programs.zsh = {
  enable = true;
  autosuggestion.enable  = true;   # was enableAutosuggestions pre-24.05
  syntaxHighlighting.enable = true;
  shellAliases = {
    ll      = "eza -la --git";
    cat     = "bat";
    rebuild = "sudo nixos-rebuild switch --flake /etc/nixos#";
  };
};

programs.starship = {   # cross-shell prompt
  enable = true;
  enableZshIntegration = true;
};`,
      },
      {
        title:"XDG & Dotfiles",
        body:["Manage dotfiles declaratively:"],
        code:`xdg.configFile."nvim/init.lua".source = ./nvim/init.lua;
xdg.configFile."kitty/kitty.conf".text = ''
  font_family JetBrains Mono
  font_size   13.0
'';

home.file.".ssh/config".text = ''
  Host github.com
    IdentityFile ~/.ssh/id_ed25519
    AddKeysToAgent yes
'';`,
        tip:"home.file targets $HOME; xdg.configFile targets ~/.config.",
      },
    ]
  },
  {
    id:"nix-store", icon:"🏗", label:"Nix Store & GC", difficulty:"intermediate",
    steps:[
      {
        title:"How the Nix Store Works",
        body:[
          "Every package lives at /nix/store/<hash>-<n>-<ver>.",
          "The hash encodes ALL build inputs — same inputs = same hash.",
          "Multiple versions coexist; nothing ever conflicts.",
          "Generations are symlinks pointing into the store.",
        ],
        tip:"du -sh /nix/store shows total store disk usage.",
      },
      {
        title:"Generations & Rollback",
        body:[],
        code:`nixos-rebuild list-generations
nixos-rebuild switch --rollback       # undo last switch

# Home Manager:
home-manager generations
home-manager rollback

# Or select any generation from GRUB/systemd-boot menu`,
        tip:"Keep 2–3 recent generations before running GC.",
      },
      {
        title:"Garbage Collection",
        body:[],
        code:`nix-collect-garbage          # remove unreachable paths
nix-collect-garbage -d       # + delete old generations
nix store optimise           # deduplicate with hard-links

# Declarative (recommended):
nix.gc = {
  automatic = true;
  dates     = "weekly";
  options   = "--delete-older-than 30d";
};
nix.optimise.automatic = true;`,
        tip:"Always rebuild after manual GC to verify system roots still work.",
      },
      {
        title:"Inspecting Closures",
        body:[],
        code:`nix path-info -r $(which git)          # all deps of git
nix path-info -rS $(which firefox)     # closure with sizes
nix why-depends nixpkgs#firefox nixpkgs#openssl

# Diff two generations:
nix store diff-closures \\
  /nix/var/nix/profiles/system-40-link \\
  /nix/var/nix/profiles/system-41-link`,
      },
    ]
  },
  {
    id:"secrets", icon:"🔑", label:"Secrets Management", difficulty:"advanced",
    steps:[
      {
        title:"The Problem",
        body:[
          "The Nix store is world-readable — /nix/store is mode 555.",
          "Any secret in a .nix file ends up in the store: visible to",
          "every local user and in git history forever.",
          "",
          "Two community tools solve this: agenix and sops-nix.",
        ],
        tip:"Never use environment.etc or literals in config for secrets.",
      },
      {
        title:"agenix — Age Encryption",
        body:[],
        code:`# flake.nix inputs:
inputs.agenix.url = "github:ryantm/agenix";

# configuration.nix:
imports = [ inputs.agenix.nixosModules.default ];
age.identityPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
age.secrets.dbPassword = {
  file  = ./secrets/dbPassword.age;
  owner = "postgres";
  mode  = "0400";
};
# Runtime: config.age.secrets.dbPassword.path`,
        tip:'Edit: nix run github:ryantm/agenix -- -e secrets/file.age',
      },
      {
        title:"sops-nix — SOPS Integration",
        body:["Supports age, GPG, AWS/GCP/Azure KMS:"],
        code:`inputs.sops-nix.url = "github:Mic92/sops-nix";

sops = {
  defaultSopsFile = ./secrets/secrets.yaml;
  age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
  secrets.apiKey  = {};
  secrets.certKey = { owner = "nginx"; };
};
# Runtime: config.sops.secrets.apiKey.path`,
        tip:"sops-nix suits teams better — multiple key holders, easy rotation.",
      },
      {
        title:"Impermanence (Advanced)",
        body:["Opt-in persistence: / is a fresh tmpfs each reboot."],
        code:`# Only listed paths survive reboot
environment.persistence."/persist" = {
  directories = [
    "/var/lib" "/var/log" "/etc/nixos"
    { directory = "/home/alice"; user = "alice"; }
  ];
  files = [
    "/etc/machine-id"
    "/etc/ssh/ssh_host_ed25519_key"
    "/etc/ssh/ssh_host_ed25519_key.pub"
  ];
};`,
        tip:"Requires programs.fuse.enable = true for FUSE bind mounts.",
      },
    ]
  },
  {
    id:"debug", icon:"🔍", label:"Debugging NixOS", difficulty:"advanced",
    steps:[
      {
        title:"Build & Eval Errors",
        body:[],
        code:`# Full trace:
nixos-rebuild switch --show-trace
nixos-rebuild switch --verbose

# Build log for a derivation:
nix log /nix/store/<hash>.drv

# Interactive eval:
nix repl
> :lf /etc/nixos      # load your flake
> nixosConfigurations.hostname.config.networking`,
        tip:"Most errors are option name typos. Tab-complete in nix repl is invaluable.",
      },
      {
        title:"Systemd Service Failures",
        body:[],
        code:`systemctl --failed                  # all failed units
systemctl status <service>
journalctl -u <service> -f         # follow logs
journalctl -b -p err               # all errors this boot
journalctl --since "10 min ago"
systemctl cat <service>            # generated unit file`,
        tip:"journalctl -xe gives a formatted error context on startup failures.",
      },
      {
        title:"Inspecting Options",
        body:[],
        code:`nixos-option networking.firewall.enable
nixos-option services.openssh      # list sub-options

# With flakes:
nix eval .#nixosConfigurations.hostname.config.networking.hostName`,
      },
      {
        title:"Package & Closure Debugging",
        body:[],
        code:`# Why is something in the closure?
nix why-depends /run/current-system nixpkgs#some-pkg

# Build a package standalone:
nix build nixpkgs#hello
nix build .#packages.x86_64-linux.myPkg

# Enter exact build environment:
nix develop nixpkgs#git
nix-shell -p python3 nodejs`,
        tip:"nix develop drops you into the exact hermetic build env of any package.",
      },
    ]
  },
];

// ─── State ────────────────────────────────────────────────────────────────────

type Screen = "home" | "settings" | "tutorials" | "tutorial-detail" | "export";

interface AppState {
  screen: Screen;
  settingSection: number;
  settingItem: number;
  focusPane: "nav" | "content";
  // Inline editing
  editing: boolean;
  editBuf: string;
  editCursor: number;
  // Tutorials
  tutorialIndex: number;
  tutorialStep: number;
  tutorialsDone: Set<string>;    // ids of completed tutorials
  // Export
  exportScroll: number;
  configCache: string[] | null;  // invalidated when settings change
  // Terminal
  termW: number; termH: number;
  // Data
  settings: Map<string, SettingValue>;
  defaults: Map<string, SettingValue>;
  // UI
  showHelp: boolean;
  statusMsg: string;
  statusKind: "info" | "ok" | "warn" | "err";
  statusTimer: ReturnType<typeof setTimeout> | null;
}

function mkDefaults(): Map<string, SettingValue> {
  const m = new Map<string, SettingValue>();
  for (const sec of SETTINGS)
    for (const s of sec.settings)
      m.set(`${sec.id}.${s.key}`, s.value);
  return m;
}

const state: AppState = {
  screen: "home",
  settingSection: 0, settingItem: 0, focusPane: "nav",
  editing: false, editBuf: "", editCursor: 0,
  tutorialIndex: 0, tutorialStep: 0, tutorialsDone: new Set(),
  exportScroll: 0, configCache: null,
  termW: process.stdout.columns || 120,
  termH: process.stdout.rows    || 40,
  settings: mkDefaults(),
  defaults: mkDefaults(),
  showHelp: false,
  statusMsg: "Ready  —  Press ? for help",
  statusKind: "info",
  statusTimer: null,
};

function invalidateConfig() { state.configCache = null; }

function setStatus(msg: string, kind: AppState["statusKind"] = "info") {
  if (state.statusTimer) { clearTimeout(state.statusTimer); state.statusTimer = null; }
  state.statusMsg  = msg;
  state.statusKind = kind;
  state.statusTimer = setTimeout(() => {
    state.statusMsg  = "";
    state.statusTimer = null;
    render();
  }, 3500);
}

function isModified(secId: string, key: string): boolean {
  const k = `${secId}.${key}`;
  return state.settings.get(k) !== state.defaults.get(k);
}

function countModified(): number {
  let n = 0;
  for (const sec of SETTINGS)
    for (const s of sec.settings)
      if (isModified(sec.id, s.key)) n++;
  return n;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const MIN_W = 80, MIN_H = 24;
const SIDEBAR_W = 24;

function renderTooSmall() {
  write(T.clear() + T.pos(1, 1));
  write(fg(P.err) + T.bold + " Terminal too small!\n" + rst);
  write(fg(P.text) + ` Need at least ${MIN_W}×${MIN_H}\n`);
  write(` Current: ${state.termW}×${state.termH}\n` + rst);
}

function renderHome() {
  const { termW, termH } = state;
  let out = "";

  // ── ASCII Banner ────────────────────────────────────────────────────────
  const banner = [
    "  ███╗   ██╗██╗██╗  ██╗ ██████╗ ███████╗",
    "  ████╗  ██║██║╚██╗██╔╝██╔═══██╗██╔════╝",
    "  ██╔██╗ ██║██║ ╚███╔╝ ██║   ██║███████╗",
    "  ██║╚██╗██║██║ ██╔██╗ ██║   ██║╚════██║",
    "  ██║ ╚████║██║██╔╝ ██╗╚██████╔╝███████║",
    "  ╚═╝  ╚═══╝╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
  ];
  const bannerW = 44;
  const bannerC = Math.max(1, Math.floor((termW - bannerW) / 2));
  const sR      = Math.max(2, Math.floor((termH - 22) / 2));

  for (let i = 0; i < banner.length; i++) {
    const t = i / banner.length;
    out += T.pos(sR + i, bannerC) + T.bold
         + T.fg(Math.round(82 + t*38), Math.round(182 - t*60), Math.round(255 - t*75))
         + banner[i] + rst;
  }

  const sub = "── Settings & Tutorial System v3 ──";
  out += T.pos(sR + banner.length + 1, Math.max(1, Math.floor((termW - sub.length) / 2)));
  out += T.dim + fg(P.muted) + sub + rst;

  // ── Navigation Cards ────────────────────────────────────────────────────
  const cards = [
    { key:"s", icon:"⚙", label:"Settings",  desc:"Configure NixOS",      clr: P.accent },
    { key:"t", icon:"❄", label:"Tutorials", desc:"Learn step by step",    clr: P.alt },
    { key:"e", icon:"⎗", label:"Export",    desc:"Preview & save config", clr: P.warn },
  ];
  const cardW = Math.min(28, Math.floor((termW - 8) / 3));
  const totW  = cards.length * (cardW + 2) - 2;
  const cC    = Math.max(2, Math.floor((termW - totW) / 2));
  const cR    = sR + banner.length + 3;
  const mods  = countModified();

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const col  = cC + i * (cardW + 2);
    if (col + cardW > termW) break;
    out += box(cR, col, cardW, 6);
    out += T.pos(cR+1, col+2) + bg(P.panel) + fg(card.clr) + T.bold + `${card.icon}  ${card.label}` + rst;
    out += T.pos(cR+2, col+2) + bg(P.panel) + T.dim + fg(P.muted) + card.desc + rst;
    out += T.pos(cR+4, col+2) + bg(P.panel) + fg(P.muted) + "Press " + fg(card.clr) + T.bold + card.key.toUpperCase() + rst + fg(P.muted) + " to open" + rst;
  }

  // Stats row
  const statsR   = cR + 7;
  const modPart  = mods > 0 ? fg(P.mod) + T.bold + `${mods} modified` + rst + fg(P.muted) + "  ·  " : "";
  const statsStr = `  ${modPart}${TUTORIALS.length} tutorials  ·  ${SETTINGS.length} sections`;
  out += T.pos(statsR, Math.max(1, Math.floor((termW - visLen(statsStr)) / 2)));
  out += bg(P.bg) + fg(P.muted) + statsStr + rst;

  // ── Sierpinski Fractal ──────────────────────────────────────────────────
  // Available vertical space below the stats row (above status bar).
  const fractalTop    = statsR + 2;
  const availRows     = termH - fractalTop - 2; // leave 2 rows for label + status bar
  const availCols     = termW - 4;
  const fractalCenter = Math.floor(termW / 2);

  if (availRows >= 2 && availCols >= 3) {
    const depth    = sierpinskiDepth(CPU_THREADS, availRows, availCols);
    const size     = 1 << depth;
    const termRows = Math.ceil(size / 2);

    // Only draw if it fits
    if (termRows <= availRows && (2 * size - 1) <= availCols) {
      write(out);
      out = "";

      write(renderSierpinski(fractalTop, fractalCenter, depth));

      // Label below fractal
      const labelRow = fractalTop + termRows + 1;
      if (labelRow < termH - 1) {
        const threadWord = CPU_THREADS === 1 ? "thread" : "threads";
        const label = `depth ${depth}  ·  ${CPU_THREADS} logical ${threadWord}`;
        const lc    = Math.max(1, Math.floor((termW - label.length) / 2));
        out += T.pos(labelRow, lc) + bg(P.bg) + T.dim + fg(P.muted) + label + rst;
      }
    }
  }

  write(out);
}

function renderSidebar() {
  const { termH, screen, settingSection, tutorialIndex } = state;
  let out = box(1, 1, SIDEBAR_W, termH - 2, "NIXOS TUI", "double");

  const nav = [
    { label:"Home",      key:"home"      as Screen, icon:"⌂" },
    { label:"Settings",  key:"settings"  as Screen, icon:"⚙" },
    { label:"Tutorials", key:"tutorials" as Screen, icon:"❄" },
    { label:"Export",    key:"export"    as Screen, icon:"⎗" },
  ];

  out += T.pos(2, 2) + bg(P.panel) + T.dim + fg(P.muted) + " Navigation" + rst;
  for (let i = 0; i < nav.length; i++) {
    const item   = nav[i];
    const active = screen === item.key
      || (screen === "tutorial-detail" && item.key === "tutorials");
    const label  = ` ${item.icon} ${padStr(item.label, SIDEBAR_W - 5)}`;
    out += T.pos(3 + i, 2);
    out += active
      ? bg(P.sel) + fg(P.selText) + T.bold + label + rst
      : bg(P.panel) + fg(P.muted) + label + rst;
  }

  // Settings sub-nav
  if (screen === "settings") {
    const max = Math.min(SETTINGS.length, termH - 13);
    out += T.pos(8, 2) + bg(P.panel) + T.dim + fg(P.muted) + " Sections" + rst;
    for (let i = 0; i < max; i++) {
      const sec    = SETTINGS[i];
      const active = settingSection === i;
      const mods   = sec.settings.filter(s => isModified(sec.id, s.key)).length;
      const modTag = mods > 0
        ? (active && state.focusPane === "nav" ? "" : rst + bg(P.panel)) + fg(P.mod) + T.bold + ` ${mods}` + rst
        : "";
      const label = ` ${sec.icon} ${padStr(sec.label, SIDEBAR_W - 7)}`;
      out += T.pos(9 + i, 2);
      if (active && state.focusPane === "nav") {
        out += bg(P.sel) + fg(P.selText) + T.bold + label + modTag + rst;
      } else if (active) {
        out += bg(P.panel) + fg(P.accent) + T.bold + label + modTag + rst;
      } else {
        out += bg(P.panel) + fg(P.muted) + label + modTag + rst;
      }
    }
  }

  // Tutorials sub-nav
  if (screen === "tutorials" || screen === "tutorial-detail") {
    const max = Math.min(TUTORIALS.length, termH - 13);
    out += T.pos(8, 2) + bg(P.panel) + T.dim + fg(P.muted) + " Guides" + rst;
    for (let i = 0; i < max; i++) {
      const t      = TUTORIALS[i];
      const active = tutorialIndex === i;
      const dClr   = t.difficulty === "beginner" ? P.alt
                   : t.difficulty === "intermediate" ? P.accent : P.warn;
      const label  = ` ${t.icon} ${padStr(t.label, SIDEBAR_W - 5)}`;
      out += T.pos(9 + i, 2);
      out += active
        ? bg(P.sel) + fg(P.selText) + T.bold + label + rst
        : bg(P.panel) + fg(dClr) + label + rst;
    }
  }

  write(out);
}

function renderSettingsContent() {
  const { termW, termH, settingSection, settingItem, focusPane, editing, editBuf, editCursor } = state;
  const cx  = SIDEBAR_W + 2;
  const cw  = termW - SIDEBAR_W - 3;
  const sec = SETTINGS[settingSection];

  let out = box(1, cx, cw, termH - 4, `${sec.icon}  ${sec.label}`, "single", focusPane === "content");

  // Table header
  out += T.pos(2, cx+1) + bg(P.panel) + T.dim + fg(P.muted)
       + "  " + padStr("Setting", 24) + "  " + padStr("Value", 20) + "  Nix Option" + rst;
  out += T.pos(3, cx+1) + bg(P.panel) + fg(P.border) + " " + B.h.repeat(cw-3) + rst;

  const visRows = termH - 8;
  const scroll  = Math.max(0, settingItem - Math.floor(visRows / 2));

  for (let i = 0; i < sec.settings.length; i++) {
    const s      = sec.settings[i];
    const k      = `${sec.id}.${s.key}`;
    const val    = state.settings.get(k) ?? s.value;
    const active = settingItem === i;
    const mod    = isModified(sec.id, s.key);
    const rowY   = 4 + (i - scroll);
    if (rowY < 4 || rowY > termH - 5) continue;

    out += T.pos(rowY, cx+1);

    const dot = mod ? fg(P.mod) + B.moddot + " " : fg(P.border) + B.dot + " ";

    let valStr: string;
    if (active && editing && (s.type === "string" || s.type === "number")) {
      const iw   = 18;
      const disp = editBuf.length > iw - 2 ? editBuf.slice(editBuf.length - (iw - 2)) : editBuf;
      const cv   = Math.min(editCursor, disp.length);
      valStr = bg(P.inputBg) + fg(P.bright) + " " + disp.slice(0, cv)
             + T.reverse + (disp[cv] ?? " ") + rst + bg(P.inputBg) + fg(P.bright)
             + disp.slice(cv + 1) + " ".repeat(Math.max(0, iw - disp.length - 1)) + rst;
    } else if (s.type === "bool") {
      valStr = val
        ? fg(P.alt)  + T.bold + B.check + " on " + rst
        : fg(P.err)  + T.dim  + B.cross + " off" + rst;
    } else if (s.type === "number") {
      valStr = fg(P.warn) + T.bold + `${val}` + rst;
    } else {
      valStr = fg(P.accent) + `"${val}"` + rst;
    }

    const label = padStr(`  ${s.label}`, 24);
    const desc  = clip(s.description, cw - 53);

    if (active && focusPane === "content") {
      out += bg(P.sel) + fg(P.muted)   + dot
           + fg(P.selText) + T.bold + padStr(` ${B.arr} ${s.label}`, 25) + "  " + rst
           + bg(P.sel) + valStr
           + bg(P.sel) + fg(P.selText) + T.dim + "  " + desc + rst;
    } else {
      out += bg(P.panel) + (mod ? fg(P.mod) : fg(P.border)) + dot
           + fg(P.text) + label + "  " + rst
           + bg(P.panel) + valStr
           + bg(P.panel) + fg(P.muted) + T.dim + "  " + desc + rst;
    }
  }

  // Bottom context bar
  const sel    = sec.settings[settingItem];
  const selVal = state.settings.get(`${sec.id}.${sel.key}`) ?? sel.value;
  const dr     = termH - 3;
  out += box(dr, cx, cw, 3);
  out += T.pos(dr+1, cx+2) + bg(P.panel);
  if (editing) {
    out += fg(P.warn) + T.bold + B.pencil + " Editing — " + rst + bg(P.panel)
         + fg(P.accent) + sel.key + rst + bg(P.panel) + fg(P.muted) + "  Enter=confirm  Esc=cancel" + rst;
  } else {
    out += fg(P.accent) + sel.key + rst + bg(P.panel)
         + fg(P.muted) + " = " + fg(P.bright) + `${selVal}` + rst + bg(P.panel);
    if (sel.type === "enum" && sel.options) {
      const opts = sel.options.map(o =>
        o === selVal ? fg(P.accent) + T.bold + o + rst + fg(P.muted) : o
      ).join(fg(P.muted) + " | ");
      out += fg(P.muted) + "   [ " + opts + fg(P.muted) + " ]" + rst;
    } else if (sel.type === "bool") {
      out += fg(P.muted) + "   ← → or Space to toggle" + rst;
    } else if (sel.type === "number") {
      out += fg(P.muted) + `   range: ${sel.min ?? "−∞"}…${sel.max ?? "∞"}  ← −1  → +1  Enter edit` + rst;
    } else {
      out += fg(P.muted) + "   Enter to edit  " + (sel.placeholder ? `(${sel.placeholder})` : "") + rst;
    }
  }

  write(out);
}

function renderTutorialList() {
  const { termW, termH } = state;
  const cx = SIDEBAR_W + 2, cw = termW - SIDEBAR_W - 3;
  let out  = box(1, cx, cw, termH - 2, "❄  Tutorials", "single");

  const CARD_H = 4;
  const maxV   = Math.floor((termH - 5) / CARD_H);

  for (let i = 0; i < Math.min(TUTORIALS.length, maxV); i++) {
    const t      = TUTORIALS[i];
    const active = state.tutorialIndex === i;
    const done   = state.tutorialsDone.has(t.id);
    const dClr   = t.difficulty === "beginner" ? P.alt
                 : t.difficulty === "intermediate" ? P.accent : P.warn;
    const rY     = 3 + i * CARD_H;
    const doneTag = done ? fg(P.alt) + T.bold + " ✓" + rst : "";

    out += T.pos(rY, cx+2);
    if (active) {
      const label = ` ${t.icon}  ${padStr(t.label, 30)}  ${padStr(t.difficulty, 12)}  ${t.steps.length} steps`;
      out += bg(P.sel) + fg(P.selText) + T.bold + label + rst + bg(P.sel) + doneTag + rst;
    } else {
      out += bg(P.panel) + fg(done ? P.muted : P.text) + T.bold + ` ${t.icon}  `
           + padStr(t.label, 30) + "  "
           + fg(dClr) + padStr(t.difficulty, 12) + fg(P.muted) + T.dim + `  ${t.steps.length} steps`
           + rst + bg(P.panel) + doneTag + rst;
    }
    out += T.pos(rY+1, cx+5) + bg(P.panel) + T.dim + fg(P.muted) + t.steps[0].title + rst;
    out += T.pos(rY+2, cx+2) + bg(P.panel) + T.dim + fg(P.border) + B.h.repeat(cw - 5) + rst;
  }

  out += T.pos(termH - 3, cx+2) + bg(P.panel) + fg(P.muted) + "Enter / → to open  ·  ↑↓ navigate" + rst;
  write(out);
}

function renderTutorialDetail() {
  const { termW, termH, tutorialIndex, tutorialStep } = state;
  const cx = SIDEBAR_W + 2, cw = termW - SIDEBAR_W - 3;
  const t  = TUTORIALS[tutorialIndex];
  const st = t.steps[tutorialStep];

  const title = `${t.icon}  ${t.label}  —  ${tutorialStep+1}/${t.steps.length}`;
  let out = box(1, cx, cw, termH - 2, title, "single", true);

  // Progress bar
  const bw  = cw - 6;
  const fil = Math.round((tutorialStep + 1) / t.steps.length * bw);
  out += T.pos(3, cx+3) + bg(P.panel)
       + fg(P.accent) + B.bar.repeat(fil) + fg(P.border) + B.barL.repeat(bw - fil) + rst;

  // Step title
  out += T.pos(5, cx+3) + bg(P.panel) + T.bold + fg(P.bright) + `  ${B.bullet}  ${st.title}` + rst;

  let row = 7;

  for (const line of st.body) {
    if (row > termH - 12) break;
    out += T.pos(row++, cx+3) + bg(P.panel) + fg(P.text) + "  " + line + rst;
  }

  // Code block
  if (st.code && row < termH - 10) {
    row++;
    const clines = st.code.split("\n");
    const innerH = clines.length;
    const boxH   = innerH + 2;
    if (row + boxH <= termH - 6) {
      out += box(row, cx+3, cw-5, boxH, "nix", "single");
      for (let li = 0; li < innerH; li++) {
        out += T.pos(row + 1 + li, cx+5) + bg(P.panel) + fg(P.alt);
        const ln = clines[li]
          .replace(/#[^\n]*/g, (m) => fg(P.muted) + T.dim + m + rst + fg(P.alt))
          .replace(/(=|{|}|\[|\]|;)/g, (m) => fg(P.border) + m + fg(P.alt))
          .replace(/"([^"]*)"/g, (_, s) => fg(P.warn) + `"${s}"` + fg(P.alt));
        out += ln + rst;
      }
      row += boxH + 1;
    }
  }

  if (st.tip && row < termH - 5) {
    row++;
    out += T.pos(row, cx+3) + bg(P.panel) + fg(P.warn) + T.bold + "  💡 " + rst
         + bg(P.panel) + fg(P.text) + clip(st.tip, cw - 12) + rst;
  }

  // Footer
  out += T.pos(termH - 3, cx+3) + bg(P.panel) + fg(P.muted) + "← prev  → / Enter next  Esc back";
  out += tutorialStep < t.steps.length - 1
    ? fg(P.muted) + "  ·  " + fg(P.accent) + "→ Continue" + rst
    : fg(P.muted) + "  ·  " + fg(P.alt) + T.bold + "✓ Complete!" + rst;

  write(out);
}

// ─── Config Generation ───────────────────────────────────────────────────────

/** Cached result — call invalidateConfig() whenever settings change */
function getConfig(): string[] {
  if (!state.configCache) state.configCache = generateConfig();
  return state.configCache;
}

function generateConfig(): string[] {
  const g        = (k: string) => state.settings.get(k);
  const out: string[] = [];
  const user      = (g("user.username") as string) || "alice";
  const shell     = g("user.shell") as string;
  const shellPkg  = shell === "bash" ? "bashInteractive" : shell;
  const stateVer  = (g("system.stateVersion") as string) || "24.11";

  out.push("# Auto-generated by NixOS TUI v3");
  out.push("# ⚠  Review before applying — this is a starting point, not a complete config");
  out.push("{ config, pkgs, lib, ... }:");
  out.push("{");
  out.push("");
  out.push("  # ─── User ─────────────────────────────────────────────");
  out.push(`  users.users.${user} = {`);
  out.push(`    isNormalUser  = true;`);
  out.push(`    description   = "${g("user.fullName")}";`);
  out.push(`    shell         = pkgs.${shellPkg};`);
  out.push(`    extraGroups   = [ "wheel" "networkmanager" "audio" "video" ];`);
  out.push(`    initialPassword = "changeme"; # CHANGE after first login`);
  out.push(`  };`);
  if (g("user.autologin"))
    out.push(`  services.displayManager.autoLogin = { enable = true; user = "${user}"; };`);
  if (g("user.homeManager")) {
    out.push(`  # Home Manager (wire up home-manager flake input, then uncomment):`);
    out.push(`  # home-manager.useGlobalPkgs    = true;`);
    out.push(`  # home-manager.useUserPackages  = true;`);
    out.push(`  # home-manager.users.${user}        = import ./home.nix;`);
  }
  out.push("");
  out.push("  # ─── System ───────────────────────────────────────────");
  out.push(`  networking.hostName = "${g("system.hostname")}";`);
  out.push(`  time.timeZone       = "${g("system.timezone")}";`);
  out.push(`  i18n.defaultLocale  = "${g("system.locale")}";`);
  out.push("");
  const hasFlakes = g("system.flakes");
  const hasCachix = g("packages.cachix");
  if (hasFlakes || hasCachix) {
    out.push("  nix.settings = {");
    if (hasFlakes)
      out.push('    experimental-features = [ "nix-command" "flakes" ];');
    if (hasCachix)
      out.push('    substituters = [ "https://cache.nixos.org" "https://cachix.cachix.org" ];');
    out.push("  };");
  }
  if (g("system.optimize"))
    out.push("  nix.optimise.automatic = true;");
  if (g("system.gc")) {
    out.push("  nix.gc = {");
    out.push("    automatic = true;");
    out.push('    dates     = "weekly";');
    out.push(`    options   = "--delete-older-than ${g("system.gcDays")}d";`);
    out.push("  };");
  }
  if (g("system.autoUpgrade"))
    out.push("  system.autoUpgrade.enable = true;");
  out.push("");
  out.push("  # ─── Desktop ──────────────────────────────────────────");
  const de          = g("desktop.de") as string;
  const dm          = g("desktop.dm") as string;
  const useWayland  = g("desktop.wayland") as boolean;
  const waylandNative = ["sway", "hyprland", "river"];
  if (de !== "none") {
    if (waylandNative.includes(de)) {
      // Wayland-native compositors don't need xserver
      if      (de === "sway")     out.push("  programs.sway.enable = true;");
      else if (de === "hyprland") out.push("  programs.hyprland.enable = true;");
      else if (de === "river")    out.push("  programs.river.enable = true;");
      if (dm === "greetd")        out.push("  services.greetd.enable = true;");
    } else {
      out.push("  services.xserver.enable = true;");
      if (dm === "greetd") {
        out.push("  services.greetd.enable = true;");
      } else if (dm !== "none") {
        out.push(`  services.xserver.displayManager.${dm}.enable = true;`);
      }
      if      (de === "gnome")   out.push("  services.xserver.desktopManager.gnome.enable = true;");
      else if (de === "plasma6") out.push("  services.desktopManager.plasma6.enable = true;");
      else if (de === "xfce")    out.push("  services.xserver.desktopManager.xfce.enable = true;");
      else if (de === "i3")      out.push("  services.xserver.windowManager.i3.enable = true;");
      if (useWayland) {
        if      (de === "plasma6") out.push('  services.xserver.displayManager.defaultSession = "plasmawayland";');
        else if (de === "gnome")   out.push('  services.xserver.displayManager.defaultSession = "gnome";');
      }
    }
  }
  if (g("desktop.pipewire")) {
    out.push("  hardware.pulseaudio.enable = false;");
    out.push("  services.pipewire = {");
    out.push("    enable = true; alsa.enable = true; pulse.enable = true;");
    out.push("  };");
  }
  if (g("desktop.bluetooth")) out.push("  hardware.bluetooth.enable = true;");
  if (g("desktop.printing"))  out.push("  services.printing.enable = true;");
  out.push("");
  out.push("  # ─── Network ──────────────────────────────────────────");
  if (g("network.networkmanager")) out.push("  networking.networkmanager.enable = true;");
  out.push(`  networking.firewall.enable = ${g("network.firewall")};`);
  out.push(`  networking.enableIPv6      = ${g("network.ipv6")};`);
  const dns = g("network.dns") as string;
  if      (dns === "resolved") out.push("  services.resolved.enable = true;");
  else if (dns === "dnsmasq")  out.push("  services.dnsmasq.enable = true;");
  else if (dns === "unbound")  out.push("  services.unbound.enable = true;");
  if (g("network.ssh")) {
    out.push("  services.openssh = {");
    out.push("    enable = true;");
    out.push(`    ports  = [ ${g("network.sshPort")} ];`);
    out.push("    settings = {");
    out.push(`      PasswordAuthentication = ${g("network.sshPwAuth")};`);
    out.push('      PermitRootLogin        = "no";');
    out.push("    };");
    out.push("  };");
    out.push(`  networking.firewall.allowedTCPPorts = [ ${g("network.sshPort")} ];`);
  }
  if (g("network.tailscale")) out.push("  services.tailscale.enable = true;");
  out.push("");
  out.push("  # ─── Security ─────────────────────────────────────────");
  out.push(`  security.sudo.enable             = ${g("security.sudo")};`);
  out.push(`  security.sudo.wheelNeedsPassword = ${g("security.sudoWheel")};`);
  if (g("security.apparmor")) out.push("  security.apparmor.enable = true;");
  if (g("security.tpm"))      out.push("  security.tpm2.enable = true;");
  if (g("security.polkit"))   out.push("  security.polkit.enable = true;");
  if (g("security.aslr"))     out.push('  boot.kernel.sysctl."kernel.randomize_va_space" = 2;');
  out.push("");
  out.push("  # ─── Packages ─────────────────────────────────────────");
  if (g("packages.unfree"))  out.push("  nixpkgs.config.allowUnfree = true;");
  if (g("packages.nix-ld")) out.push("  programs.nix-ld.enable = true;");
  if (g("packages.flatpak")) out.push("  services.flatpak.enable = true;");
  if (g("packages.nur")) {
    out.push("  # NUR: add 'nur' to flake inputs, then:");
    out.push("  # nixpkgs.overlays = [ nur.overlay ];");
  }
  out.push("");
  out.push("  environment.systemPackages = with pkgs; [");
  out.push(`    ${shellPkg !== "bashInteractive" ? shellPkg + " " : ""}vim git curl wget htop`);
  out.push("    # add your packages here");
  out.push("  ];");
  out.push("");
  out.push(`  system.stateVersion = "${stateVer}"; # do not change after install`);
  out.push("}");
  return out;
}

function renderExport() {
  const { termW, termH, exportScroll } = state;
  const cx   = SIDEBAR_W + 2, cw = termW - SIDEBAR_W - 3;
  const mods = countModified();
  const modTxt = mods > 0 ? "  " + fg(P.mod) + T.bold + `${mods} changes` + rst : "";
  const title  = "⎗  configuration.nix" + modTxt;

  let out = box(1, cx, cw, termH - 2, title, "accent");

  const lines    = getConfig();
  const maxLines = termH - 6;
  const maxScroll = Math.max(0, lines.length - maxLines);

  for (let i = 0; i < maxLines; i++) {
    const li = i + exportScroll;
    if (li >= lines.length) break;
    const lineNo = String(li + 1).padStart(3, " ");
    out += T.pos(3 + i, cx + 2) + bg(P.panel);
    out += T.dim + fg(P.muted) + lineNo + " " + rst + bg(P.panel) + fg(P.alt);
    const ln = lines[li]
      .replace(/#[^\n]*/g, (m) => fg(P.muted) + T.dim + m + rst + fg(P.alt))
      .replace(/(=|{|}|;|\[|\])/g, (m) => fg(P.border) + m + fg(P.alt))
      .replace(/\btrue\b|\bfalse\b/g, (m) => fg(P.warn) + T.bold + m + rst + fg(P.alt))
      .replace(/"([^"]*)"/g, (_, s) => fg(P.warn) + `"${s}"` + fg(P.alt));
    out += ln + rst;
  }

  // Footer
  out += T.pos(termH - 3, cx + 2) + bg(P.panel) + fg(P.muted);
  if (lines.length > maxLines) {
    const pct = Math.round(exportScroll / maxScroll * 100);
    out += `↑↓/PgUp/PgDn  g/G top/btm  lines ${exportScroll+1}–${Math.min(exportScroll+maxLines, lines.length)}/${lines.length} (${pct}%)  W=save` + rst;
  } else {
    out += `${lines.length} lines  ·  W = save to /tmp/configuration.nix  ·  Tab → Settings` + rst;
  }

  write(out);
}

function renderStatusBar() {
  const { termW, termH, statusMsg, statusKind, screen } = state;
  const sClr = statusKind === "ok"   ? fg(P.alt)
             : statusKind === "warn" ? fg(P.warn)
             : statusKind === "err"  ? fg(P.err)
             : fg(P.muted);
  const hints: Record<Screen, string> = {
    home:             "s Settings  t Tutorials  e Export  q Quit  ? Help",
    settings:         "↑↓ Item  ←→ Toggle/Cycle  Tab Pane  Enter Select  R Reset  ? Help",
    tutorials:        "↑↓ Select  Enter Open  q Back",
    "tutorial-detail":"← → Steps  Esc Back  q Quit",
    export:           "↑↓/PgUp/PgDn Scroll  g/G Top/Bot  W Save  Tab→Settings  q Back",
  };
  const right = statusMsg ? `  ${statusMsg}  ` : "  ";
  let out = T.pos(termH - 1, 1) + bg(P.border) + fg(P.bg) + T.bold;
  out += " " + padStr(hints[screen] || "", termW - visLen(right) - 2);
  out += rst + bg(P.border) + sClr + right + rst;
  write(out);
}

function renderHelp() {
  const { termW, termH } = state;
  const w = 58, h = 30;
  const row = Math.max(1, Math.floor((termH - h) / 2));
  const col = Math.max(1, Math.floor((termW - w) / 2));
  let out = box(row, col, w, h, " Keyboard Shortcuts ", "double");

  const entries: [string, string][] = [
    ["Navigation", ""],
    ["↑ / k",          "Move up"],
    ["↓ / j",          "Move down"],
    ["← / h",          "Prev section · back · cycle enum backward"],
    ["→ / l",          "Next section · forward · cycle enum forward"],
    ["Tab",            "Switch focus  nav ↔ content"],
    ["Enter / Space",  "Select · toggle · confirm edit"],
    ["Esc",            "Go back · cancel edit"],
    ["Ctrl+C",         "Quit from anywhere"],
    ["", ""],
    ["Global", ""],
    ["s",  "Go to Settings"],
    ["t",  "Go to Tutorials"],
    ["e",  "Go to Export"],
    ["q",  "Back / quit"],
    ["?",  "Toggle this help"],
    ["", ""],
    ["Settings", ""],
    ["← →",    "Toggle bool  |  Cycle enum  |  ±1 number"],
    ["Enter",  "Edit string / number field  |  toggle bool"],
    ["Tab",    "Switch nav pane ↔ content pane"],
    ["R",      "Reset current section to defaults"],
    ["", ""],
    ["Export", ""],
    ["↑ ↓ / PgUp PgDn", "Scroll config preview"],
    ["g / G",           "Jump to top / bottom"],
    ["W",               "Write config to /tmp/configuration.nix"],
    ["Tab",             "Jump to Settings"],
  ];

  for (let i = 0; i < entries.length && i < h - 3; i++) {
    const [k, v] = entries[i];
    out += T.pos(row + 1 + i, col + 2) + bg(P.panel);
    out += !v
      ? T.bold + fg(P.accent) + "  " + k + rst
      : fg(P.selText) + T.bold + "  " + padStr(k, 22) + rst + bg(P.panel) + fg(P.muted) + v + rst;
  }

  out += T.pos(row + h - 2, col + 2) + bg(P.panel) + fg(P.muted) + "  Press ? or Esc to close" + rst;
  write(out);
}

function render() {
  if (state.termW < MIN_W || state.termH < MIN_H) { renderTooSmall(); return; }
  write(T.hideCursor + bg(P.bg) + T.clear());
  if (state.screen === "home") {
    renderHome();
  } else {
    renderSidebar();
    switch (state.screen) {
      case "settings":         renderSettingsContent(); break;
      case "tutorials":        renderTutorialList();    break;
      case "tutorial-detail":  renderTutorialDetail();  break;
      case "export":           renderExport();          break;
    }
  }
  renderStatusBar();
  if (state.showHelp) renderHelp();
  write(T.pos(state.termH, 1));
}

// ─── Input ────────────────────────────────────────────────────────────────────

function adjustSetting(sec: SettingsSection, s: Setting, dir: 1 | -1) {
  const k   = `${sec.id}.${s.key}`;
  const val = state.settings.get(k);
  if (s.type === "enum" && s.options) {
    const idx  = s.options.indexOf(val as string);
    const next = s.options[((idx + dir) + s.options.length) % s.options.length];
    state.settings.set(k, next);
    invalidateConfig();
    setStatus(`${s.label} = "${next}"`, "ok");
  } else if (s.type === "number") {
    const next = Math.max(s.min ?? -Infinity, Math.min(s.max ?? Infinity, (val as number) + dir));
    state.settings.set(k, next);
    invalidateConfig();
    setStatus(`${s.label} = ${next}`, "ok");
  }
}

function toggleBool(sec: SettingsSection, s: Setting) {
  if (s.type !== "bool") return;
  const k    = `${sec.id}.${s.key}`;
  const next = !state.settings.get(k);
  state.settings.set(k, next);
  invalidateConfig();
  setStatus(`${s.label} → ${next ? "enabled" : "disabled"}`, next ? "ok" : "warn");
}

function beginEdit(sec: SettingsSection, s: Setting) {
  if (s.type !== "string" && s.type !== "number") return;
  const val = String(state.settings.get(`${sec.id}.${s.key}`) ?? s.value);
  state.editing    = true;
  state.editBuf    = val;
  state.editCursor = val.length;
}

function commitEdit(sec: SettingsSection, s: Setting) {
  const k = `${sec.id}.${s.key}`;
  if (s.type === "number") {
    const n = parseFloat(state.editBuf);
    if (isNaN(n)) { setStatus("Invalid number", "err"); return; }
    const clamped = Math.max(s.min ?? -Infinity, Math.min(s.max ?? Infinity, n));
    state.settings.set(k, clamped);
    invalidateConfig();
    setStatus(`${s.label} = ${clamped}`, "ok");
  } else {
    const v = state.editBuf.trim();
    if (!v) { setStatus("Value cannot be empty", "err"); return; }
    // Hostname: RFC 1123 — alphanumeric + hyphens, no leading/trailing hyphen
    if (k === "system.hostname") {
      const valid = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(v);
      if (!valid) { setStatus("Invalid hostname (a-z 0-9 hyphens only)", "err"); return; }
    }
    // Username: POSIX — lowercase, digits, underscores, hyphens
    if (k === "user.username") {
      const valid = /^[a-z_][a-z0-9_-]{0,30}$/.test(v);
      if (!valid) { setStatus("Invalid username (lowercase, digits, _ - only)", "err"); return; }
    }
    state.settings.set(k, v);
    invalidateConfig();
    setStatus(`${s.label} = "${v}"`, "ok");
  }
  state.editing = false;
}

function saveConfig() {
  const path = "/tmp/configuration.nix";
  try {
    const text = getConfig().join("\n") + "\n";
    require("fs").writeFileSync(path, text, "utf8");
    setStatus(`✓ Saved ${getConfig().length} lines → ${path}`, "ok");
  } catch (e: any) {
    setStatus(`✗ Save failed: ${e.message}`, "err");
  }
}

function handleKey(raw: Buffer) {
  const hex = raw.toString("hex");
  const str = raw.toString();

  const isUp       = hex === "1b5b41" || str === "k";
  const isDown     = hex === "1b5b42" || str === "j";
  const isRight    = hex === "1b5b43" || str === "l";
  const isLeft     = hex === "1b5b44" || str === "h";
  const isEnter    = str === "\r" || str === "\n";
  const isSpace    = str === " ";
  const isEsc      = hex === "1b";   // bare ESC only — NOT 1b5b.. sequences
  const isBs       = str === "\x7f" || str === "\b";
  const isTab      = str === "\t";
  const isCtrlC    = str === "\x03";
  const isQ        = str === "q";
  const isHelp     = str === "?";
  const isW        = str === "w" || str === "W";
  const isR        = str === "r" || str === "R";
  const isPageUp   = hex === "1b5b357e";  // PgUp
  const isPageDown = hex === "1b5b367e";  // PgDn

  if (isCtrlC) { cleanup(); process.exit(0); }

  if (isHelp && !state.editing) { state.showHelp = !state.showHelp; render(); return; }
  if (state.showHelp) {
    if (isEsc || isHelp || isQ) state.showHelp = false;
    render(); return;
  }

  // ─ Editing mode ──────────────────────────────────────────────────────────
  if (state.editing) {
    const sec = SETTINGS[state.settingSection];
    const s   = sec.settings[state.settingItem];
    if (isEsc) {
      state.editing = false;
      setStatus("Edit cancelled");
    } else if (isEnter) {
      commitEdit(sec, s);
    } else if (isBs) {
      if (state.editCursor > 0) {
        state.editBuf    = state.editBuf.slice(0, state.editCursor - 1) + state.editBuf.slice(state.editCursor);
        state.editCursor--;
      }
    } else if (isLeft)  { state.editCursor = Math.max(0, state.editCursor - 1); }
    else if (isRight)   { state.editCursor = Math.min(state.editBuf.length, state.editCursor + 1); }
    else if (raw.length === 1 && raw[0] >= 0x20) {
      state.editBuf    = state.editBuf.slice(0, state.editCursor) + str + state.editBuf.slice(state.editCursor);
      state.editCursor++;
    }
    render(); return;
  }

  const { screen } = state;

  // ─ Home ──────────────────────────────────────────────────────────────────
  if (screen === "home") {
    if      (str === "s") { state.screen = "settings"; state.focusPane = "nav"; }
    else if (str === "t") state.screen = "tutorials";
    else if (str === "e") state.screen = "export";
    else if (isQ || isEsc) { cleanup(); process.exit(0); }
    render(); return;
  }

  // q / Esc → home (except inside tutorial-detail)
  if (screen !== "tutorial-detail" && (isQ || isEsc)) {
    state.screen = "home";
    render(); return;
  }

  // ─ Settings ──────────────────────────────────────────────────────────────
  if (screen === "settings") {
    if (isTab) {
      state.focusPane = state.focusPane === "nav" ? "content" : "nav";
    } else if (state.focusPane === "nav") {
      if (isUp)             state.settingSection = (state.settingSection - 1 + SETTINGS.length) % SETTINGS.length;
      if (isDown)           state.settingSection = (state.settingSection + 1) % SETTINGS.length;
      if (isEnter || isRight) { state.focusPane = "content"; state.settingItem = 0; }
    } else {
      const sec = SETTINGS[state.settingSection];
      const s   = sec.settings[state.settingItem];
      if (isUp)    state.settingItem = (state.settingItem - 1 + sec.settings.length) % sec.settings.length;
      if (isDown)  state.settingItem = (state.settingItem + 1) % sec.settings.length;
      if (isLeft) {
        if (s.type === "bool") toggleBool(sec, s);
        else if (s.type === "enum" || s.type === "number") adjustSetting(sec, s, -1);
        else state.focusPane = "nav";
      }
      if (isRight) {
        if (s.type === "bool") toggleBool(sec, s);
        else if (s.type === "enum" || s.type === "number") adjustSetting(sec, s, 1);
      }
      if (isSpace) {
        if (s.type === "bool") toggleBool(sec, s);
        else if (s.type === "enum") adjustSetting(sec, s, 1);
      }
      if (isEnter) {
        if (s.type === "string" || s.type === "number") beginEdit(sec, s);
        else toggleBool(sec, s);
      }
      if (isR) {
        for (const setting of sec.settings)
          state.settings.set(`${sec.id}.${setting.key}`, state.defaults.get(`${sec.id}.${setting.key}`) ?? setting.value);
        invalidateConfig();
        setStatus(`${sec.label} reset to defaults`, "info");
      }
    }
    render(); return;
  }

  // ─ Tutorials list ────────────────────────────────────────────────────────
  if (screen === "tutorials") {
    if (isUp)   state.tutorialIndex = (state.tutorialIndex - 1 + TUTORIALS.length) % TUTORIALS.length;
    if (isDown) state.tutorialIndex = (state.tutorialIndex + 1) % TUTORIALS.length;
    if (isEnter || isRight || isSpace) { state.screen = "tutorial-detail"; state.tutorialStep = 0; }
    render(); return;
  }

  // ─ Tutorial detail ────────────────────────────────────────────────────────
  if (screen === "tutorial-detail") {
    const t = TUTORIALS[state.tutorialIndex];
    if (isRight || isEnter || isSpace) {
      if (state.tutorialStep < t.steps.length - 1) {
        state.tutorialStep++;
      } else {
        state.tutorialsDone.add(t.id);
        setStatus(`✓ "${t.label}" complete!`, "ok");
      }
    }
    if (isLeft && state.tutorialStep > 0) state.tutorialStep--;
    if (isEsc || isQ) state.screen = "tutorials";
    render(); return;
  }

  // ─ Export ─────────────────────────────────────────────────────────────────
  if (screen === "export") {
    const pageSize  = Math.max(1, state.termH - 8);
    const maxScroll = Math.max(0, getConfig().length - (state.termH - 6));
    if (isUp)       state.exportScroll = Math.max(0, state.exportScroll - 1);
    if (isDown)     state.exportScroll = Math.min(maxScroll, state.exportScroll + 1);
    if (isPageUp)   state.exportScroll = Math.max(0, state.exportScroll - pageSize);
    if (isPageDown) state.exportScroll = Math.min(maxScroll, state.exportScroll + pageSize);
    if (str === "g") state.exportScroll = 0;
    if (str === "G") state.exportScroll = maxScroll;
    if (isW)        saveConfig();
    if (isTab)      { state.screen = "settings"; state.focusPane = "nav"; }
    render(); return;
  }

  render();
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

function cleanup() {
  write(T.showCursor + T.altOff + rst + "\n");
}

function main() {
  // No process.on("exit") — cleanup is called explicitly before process.exit()
  // to avoid double-firing showCursor + altOff on the already-reset terminal.
  process.on("SIGINT",  () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  process.stdout.on("resize", () => {
    state.termW = process.stdout.columns;
    state.termH = process.stdout.rows;
    render();
  });

  write(T.altOn + T.hideCursor);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer) => handleKey(chunk));

  render();
}

main();
