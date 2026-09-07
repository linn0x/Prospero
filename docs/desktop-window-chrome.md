# Desktop sidebar and window toolbar

Drag the sidebar's outer edge to resize it between 200 and 420 px. The content keeps at least 480 px when the window narrows. The collapsed sidebar is 52 px wide. The toolbar button toggles it without losing the saved expanded width; double-clicking the edge restores 240 px.

The edge is keyboard focusable: Left/Right adjust 10 px, Home/End select the available minimum/maximum, and Escape cancels an active drag. Pointer capture keeps a drag active outside the edge. Window blur and pointer cancellation restore the previous width and clear the cursor. Movement updates only the width CSS variable once per animation frame; release commits the preference and repeated keyboard changes share a 180 ms save debounce.

The 44 px window toolbar spans both panes, including focus mode. On macOS it reserves native traffic-light space and places the sidebar toggle beside the controls. Sidebar dividers begin below the toolbar, and primary navigation buttons are 28 px high in both expanded and collapsed layouts.

Run `npm run check:chrome -w @prospero/desktop` for the native Electron interaction check. It uses a temporary application home with daemon startup disabled, drives real mouse and keyboard events, checks persisted width and actual layout bounds, and saves application screenshots in the temporary result directory. It replaces the previous source-text assertions for traffic-light spacing.
