import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * UI state only.
 *
 * The rule that keeps this app from fighting itself (§12): document text lives
 * in Yjs, server data lives in TanStack Query, and Monaco and xterm own their
 * own buffers. Zustand holds tabs, panel sizes and preferences — nothing that
 * changes on a keystroke.
 */

/** Exactly two themes. The app does not follow the OS setting. */
export type ThemeName = 'light' | 'dark';

export interface OpenTab {
  fileId: string;
  name: string;
}

interface UiState {
  theme: ThemeName;
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;

  openTabs: OpenTab[];
  activeFileId: string | null;

  sidebarPanel: 'files' | 'members' | 'runs' | 'settings' | null;
  rightPanel: 'chat' | 'call' | null;
  /**
   * Someone said something while the chat panel was shut.
   *
   * Deliberately a flag rather than a count: the dot answers "is there anything
   * new", and a number would imply we track what you have read message by
   * message, which we do not. Never persisted — a dot surviving a reload would
   * point at a conversation you have already seen.
   */
  unreadChat: boolean;
  terminalVisible: boolean;

  /** socketId of the peer whose viewport we are following, if any. */
  followingPeerId: string | null;

  setTheme: (theme: ThemeName) => void;
  setFontSize: (size: number) => void;
  setTabSize: (size: number) => void;
  toggleWordWrap: () => void;
  toggleMinimap: () => void;

  openTab: (tab: OpenTab) => void;
  closeTab: (fileId: string) => void;
  renameTab: (fileId: string, name: string) => void;
  setActiveFile: (fileId: string | null) => void;
  closeTabsFor: (fileIds: string[]) => void;

  setSidebarPanel: (panel: UiState['sidebarPanel']) => void;
  setRightPanel: (panel: UiState['rightPanel']) => void;
  markChatUnread: () => void;
  toggleTerminal: () => void;
  setFollowing: (peerId: string | null) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      fontSize: 14,
      tabSize: 4,
      wordWrap: false,
      minimap: false,

      openTabs: [],
      activeFileId: null,

      sidebarPanel: 'files',
      rightPanel: null,
      unreadChat: false,
      terminalVisible: true,
      followingPeerId: null,

      setTheme: (theme) => set({ theme }),
      setFontSize: (fontSize) => set({ fontSize: Math.min(28, Math.max(10, fontSize)) }),
      setTabSize: (tabSize) => set({ tabSize }),
      toggleWordWrap: () => set({ wordWrap: !get().wordWrap }),
      toggleMinimap: () => set({ minimap: !get().minimap }),

      openTab: (tab) => {
        const { openTabs } = get();
        const exists = openTabs.some((t) => t.fileId === tab.fileId);
        set({
          openTabs: exists ? openTabs : [...openTabs, tab],
          activeFileId: tab.fileId,
        });
      },

      closeTab: (fileId) => {
        const { openTabs, activeFileId } = get();
        const index = openTabs.findIndex((t) => t.fileId === fileId);
        const remaining = openTabs.filter((t) => t.fileId !== fileId);

        // Closing the active tab should land on its neighbour, the way every
        // editor behaves — not dump the user on an empty pane.
        let nextActive = activeFileId;
        if (activeFileId === fileId) {
          const neighbour = remaining[Math.min(index, remaining.length - 1)];
          nextActive = neighbour?.fileId ?? null;
        }
        set({ openTabs: remaining, activeFileId: nextActive });
      },

      closeTabsFor: (fileIds) => {
        const doomed = new Set(fileIds);
        const remaining = get().openTabs.filter((t) => !doomed.has(t.fileId));
        const active = get().activeFileId;
        set({
          openTabs: remaining,
          activeFileId: active && doomed.has(active) ? (remaining[0]?.fileId ?? null) : active,
        });
      },

      renameTab: (fileId, name) =>
        set({ openTabs: get().openTabs.map((t) => (t.fileId === fileId ? { ...t, name } : t)) }),

      setActiveFile: (activeFileId) => set({ activeFileId, followingPeerId: null }),

      setSidebarPanel: (sidebarPanel) =>
        set({ sidebarPanel: get().sidebarPanel === sidebarPanel ? null : sidebarPanel }),
      setRightPanel: (rightPanel) => {
        // Clicking the panel you are already on closes it, so read the result
        // rather than the argument — opening chat is what clears the dot, and
        // toggling it shut is not opening it.
        const next = get().rightPanel === rightPanel ? null : rightPanel;
        set({ rightPanel: next, unreadChat: next === 'chat' ? false : get().unreadChat });
      },

      markChatUnread: () => {
        if (get().rightPanel !== 'chat') set({ unreadChat: true });
      },
      toggleTerminal: () => set({ terminalVisible: !get().terminalVisible }),
      setFollowing: (followingPeerId) => set({ followingPeerId }),
    }),
    {
      name: 'codexa-ui',

      /**
       * An earlier version offered a third choice, `system`, that followed the
       * OS. Anyone who picked it still has that string in localStorage, and
       * left alone it goes straight to `data-theme`, where no token block
       * matches it — a silent fall back to the defaults. So it is resolved
       * once, to whatever the OS is asking for now, and their screen does not
       * change underneath them.
       *
       * This is `merge` rather than `migrate` because `migrate` would never
       * run: zustand only calls it when the stored `version` is a *number*, and
       * data written before `version` existed has no such key. `merge` runs on
       * every hydration, whatever the stored shape. The boot script in
       * index.html applies the same rule so the two agree and there is no
       * flash between them.
       */
      merge: (persisted, current) => {
        // `theme` widened to string on purpose: the point is to handle a value
        // the current type no longer admits.
        const saved = (persisted ?? {}) as Omit<Partial<UiState>, 'theme'> & { theme?: string };

        let theme: ThemeName;
        if (saved.theme === 'light' || saved.theme === 'dark') {
          theme = saved.theme;
        } else if (saved.theme === 'system') {
          theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        } else {
          theme = current.theme;
        }

        return { ...current, ...saved, theme };
      },
      // Tabs are per-project and restoring them across projects is confusing;
      // only durable preferences and layout survive a reload.
      partialize: (state) => ({
        theme: state.theme,
        fontSize: state.fontSize,
        tabSize: state.tabSize,
        wordWrap: state.wordWrap,
        minimap: state.minimap,
        sidebarPanel: state.sidebarPanel,
        rightPanel: state.rightPanel,
        terminalVisible: state.terminalVisible,
      }),
    },
  ),
);

/* ─── Appearance ────────────────────────────────────────────────────────────── */

/** The chosen theme. There is nothing to resolve — the setting is the answer. */
export function useColorMode(): ThemeName {
  return useUiStore((s) => s.theme);
}

/**
 * The Monaco theme name for the current theme.
 *
 * Monaco needs a registered name, and `light`/`dark` are close enough to its
 * own built-ins to be worth namespacing away from.
 */
export function useEditorTheme(): `codexa-${ThemeName}` {
  return `codexa-${useColorMode()}`;
}
