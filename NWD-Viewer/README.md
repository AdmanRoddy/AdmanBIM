# AdmanWorks

Opens Navisworks **.nwd** and **.nwc** files on an iPad (or any computer) and works like Navisworks Freedom:
model tree, properties, saved viewpoints with their section cuts, orbit / pan / zoom / look / walk,
hide / isolate, sectioning, measuring and find.

It reads the Navisworks file directly on the device. Nothing is uploaded and nothing from Autodesk is
used , the file format reader was written from scratch by studying sample files.

One HTML file. Add it to the iPad home screen and it runs full screen like an app, offline included.

---

## 1. GitHub Pages

This app lives in the `NWD-Viewer` folder of the [AdmanBIM](https://github.com/AdmanRoddy/AdmanBIM) repository.
Turn on **Settings → Pages → Source: Deploy from a branch → main / (root)** once, and a minute later it is live at
`https://admanroddy.github.io/AdmanBIM/NWD-Viewer/`.

The model files never go to GitHub , only the viewer does.

## 2. Put it on the iPad

1. Open the GitHub Pages link in **Safari**.
2. **Share → Add to Home Screen**.
3. Open it from the home screen once while online. After that it also works with no signal.

## 3. Open a model

Tap **Open** and pick the .nwd / .nwc from Files , iCloud Drive, OneDrive, SharePoint, Box, or "On My iPad".
A 1.5 GB federated model opens in roughly 10 to 30 seconds; detail then streams in as you move around,
the same way Navisworks does. Files stored in the cloud are downloaded by the Files app first.

Tip: for the job-site iPad, keep a copy of the current field model in **On My iPad** so it opens with no signal.

## Using it

| Gesture | Action |
|---|---|
| Tap | Select (blue highlight; properties open with the **Properties** button) |
| Double-tap | Focus on that spot |
| Press and hold | Menu: zoom to, hide, hide unselected, properties, show in tree |
| One-finger drag | Current tool , Orbit (around the point you touch), Pan, Zoom, Look or Walk |
| Two-finger drag / pinch | Pan and zoom toward your fingers |

With a mouse: left-drag uses the tool, right- or middle-drag pans, wheel zooms toward the cursor,
Ctrl-click adds to the selection. Keys: **W A S D / Q E** walk, **H** hide, **I** hide unselected,
**U** unhide all, **F** zoom to selection, **Esc** clear selection.

**Toolbar**

- **Orbit / Pan / Zoom / Look / Walk** , Navisworks navigation tools. Walk: drag up/down to move, left/right to turn.
- **All / Selected** , zoom to the whole model or the selection. **Views** , top, front, sides, iso.
- **Hide / Isolate / Unhide** , same as Navisworks Hide, Hide Unselected, Unhide All.
- **Measure** , tap two points: distance, ΔX/ΔY/ΔZ and horizontal distance in feet-inches.
- **Section** , one plane (top/bottom/front/back/left/right) or a section box; "Fit box to selection".
- **Style** , shaded or wireframe. **Settings** , detail level, selection resolution, background, lines.

**Panels**

- **Selection Tree** , the Navisworks Standard tree (files, layers, categories, families, types, objects).
  Tap to select, double-tap to zoom, the eye icon hides/unhides that branch.
- **Viewpoints** , the file's saved viewpoints and folders. Going to a viewpoint restores its camera and its
  section plane. "Save current view" keeps extra views on this device.
- **Find** , search object names and types, e.g. *Panel LP-1*, *Cable Tray*, *Doors*.
- **Properties** , Navisworks-style tabs: Item, Element, Custom, Type, Type Custom, Element ID, Phase, Material,
  Hyperlinks, Transform… Element and Custom hold the Revit and eVolve parameters (conduit size, trade size,
  length, part description). Selecting a fitting or a piece of geometry shows the properties of the object it
  belongs to. In large NWD files these properties load in the background a few seconds after the model
  appears; until then the Item tab says they are still loading.

## Settings → Detail / performance

The viewer keeps a set number of triangles on screen and loads the most visible objects first. If that hides anything in view, a red "Detail limit reached" tag appears; tap it to open Settings.

| Setting | Triangles | Use on |
|---|---|---|
| Low | 2.5 M | older iPads |
| Medium | 5 M | current iPads (default on iPad) |
| High | 8 M | iPad Pro / M-series (default on computers) |
| Ultra | 15 M | desktop computers |

## What it reads

Navisworks 2015-2026 .nwd and .nwc files (the current "lichunk-008" file format), including federated
models with many appended files. Older pre-2015 files are refused with a message , re-save them in Navisworks.

Not yet supported: textures, clash test results, TimeLiner, animations, redline markups, comments,
saved hide/colour overrides inside viewpoints, AutoCAD circle primitives (drawn by Navisworks as rings),
and orthographic viewpoints (shown with a matching perspective camera).

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app (built from `src/`) |
| `manifest.json`, `sw.js`, `icon-*.png` | Home-screen app + offline support |
| `src/core.js` | Navisworks file reader (container, geometry, objects, model tree, element properties, viewpoints) |
| `src/worker.js` | Background engine: spatial index, streaming, model-tree queries |
| `src/app.js`, `src/style.css`, `src/index.template.html` | Viewer, controls and panels |
| `build.mjs` | `node build.mjs` , rebuilds `index.html` after editing `src/` |
| `tools/` | Development tools: format test harness, dev server with sample models, icon generator |

Development: list a few local models in `tools/models.local.json` (kept out of git), e.g.
`{ "sample.nwd": "C:/Models/Sample.nwd" }`, run `node tools/devserver.mjs 8770` and open
`http://localhost:8770/?url=/models/sample.nwd`. `node tools/test-core.cjs <file.nwd>` checks the file reader from the
command line, `node tools/batch.cjs list.txt` runs it over a list of files, and `node tools/propcheck.cjs <file.nwd>`
checks that element properties line up with the model tree.
