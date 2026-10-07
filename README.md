# Building 360 plugin

Four straight-on photos of a residential building become an orbitable 3D building of any
footprint (L, U, T, notches, a podium with a tower), lit by a sun that casts real shadows, with
depth worked out from the photos so slabs stand out and windows sit back. Apartments
marked on the facades light up in 3D; buyers tap one, see its details, and **Select** it, which
notifies the page that embeds the widget. That page (ABB Home) takes over from there: listing,
lead form, mortgage calculator.

- **Widget** `<abb-building-360>`: the embeddable 3D viewer. One script, no dependencies on the host page.
- **Editor**: a static page that turns four photos into the widget's config file (`building.json`).
- **Example host page**: the widget embedded in a page, with its events and API wired up.

No backend: the host page supplies the config and owns everything that happens after Select.

## Try it

```sh
npm install
npm run dev        # http://localhost:5173/ → example host page and editor
```

The demo building uses four renders of a real project (see `public/demo/assets/NOTICE.md`) and
104 made-up sample apartments.

## Embed the widget

Build once (`npm run build`), host `dist/lib/abb-building-360.iife.js`, then:

```html
<script src="https://cdn.example.com/abb-building-360.iife.js"></script>

<abb-building-360 config-url="https://cdn.example.com/buildings/123/building.json" locale="az"
                  availability="shown"></abb-building-360>

<script>
  document.querySelector('abb-building-360').addEventListener('apartment-select', (e) => {
    // e.detail = { apartmentId, number, floor, status }
    location.href = `/apartments/${e.detail.apartmentId}`;
  });
</script>
```

With a bundler, use the ES build (`dist/lib/abb-building-360.js`) and `mount()`:

```js
import { mount } from './abb-building-360.js';

const widget = mount(document.getElementById('building'), {
  configUrl: '/buildings/123/building.json', // or config: {...}; its relative paths resolve against the page URL
  locale: 'az',
  selectable: ['available'],                  // statuses whose Select button is enabled
  onSelect: ({ apartmentId }) => openListing(apartmentId),
  onPreview: ({ apartmentId }) => analytics.track('apartment_viewed', { apartmentId }),
});

widget.setApartments([{ id: 'apt-1203', status: 'reserved' }]); // live data from your backend
widget.destroy();                                               // releases the WebGL context
```

### Events

All events bubble and cross the shadow DOM (`composed`). Calls from the host (`openApartment`,
`setApartments`, `setFilter`) never emit events, so host and widget can't trigger each other in a loop.

| Event | When | `detail` |
|---|---|---|
| `ready` | Building loaded and drawn | `{ buildingId, apartments, warnings }` |
| `error` | Config couldn't load, or no WebGL | `{ message, cause }` |
| `apartment-hover` | Mouse moves onto / off an apartment | `{ apartmentId, number, floor, status }` or `null` |
| `apartment-preview` | Buyer tapped an apartment; details panel open | `{ apartmentId, number, floor, status }` |
| `apartment-select` | Buyer pressed **Select apartment** | `{ apartmentId, number, floor, status }` |

### Methods (on the element and on `mount()`'s return value)

| Method | |
|---|---|
| `openApartment(id)` | Opens the details panel and turns the camera to the apartment. Returns false for an unknown id. |
| `closeApartment()` | Closes the panel. |
| `setApartments(patches)` | Merges `{ id, ...fields }` updates (status, price, …). Returns ids it didn't know. Calls made before `ready` are applied once the building loads. |
| `setFilter(filter \| null)` | Dims apartments that don't match `{ status?, rooms?, minFloor?, maxFloor?, minPrice?, maxPrice?, minArea?, maxArea?, ids? }`; dimmed apartments can't be tapped. Prices are in minor units. |
| `getApartmentScreenPosition(id)` | Viewport coordinates of the apartment as drawn, or null when out of view (for callouts). |
| `building` (getter) | The parsed config currently shown. |

### Size and look

`availability="hidden"` starts with the plain building (only hovered, tapped and filtered apartments
are coloured); the default is `shown`. Buyers can flip it with the **Show availability** switch in
the legend; that never sends events to the host.

The element is a block with `aspect-ratio: 4 / 3` (`4 / 5` on viewports under 600 px). Override it
with ordinary CSS, e.g. `abb-building-360 { aspect-ratio: auto; height: 640px; }`.

Theme with CSS custom properties on the element: `--abb360-accent`, `--abb360-accent-text`,
`--abb360-surface`, `--abb360-text`, `--abb360-muted`, `--abb360-radius`, `--abb360-background`,
`--abb360-font`.

### Behaviour inside your page

- A plain mouse wheel scrolls your page; Ctrl/⌘ + wheel or a trackpad pinch zooms the building.
- On touch screens a vertical swipe scrolls your page, a sideways swipe rotates, and two fingers zoom.
- On narrow widgets (≤ 560 px) the details panel is a bottom sheet and the camera zooms in on the apartment.
- `prefers-reduced-motion` turns camera flights into cuts.
- Each widget holds one WebGL context. Removing the element from the DOM releases it; moving it doesn't.

## The config file (schema v1)

```jsonc
{
  "schemaVersion": 1,
  "id": "demo-residence",
  "name": "Demo residence",
  "dimensions": { "width": 29.39, "depth": 22.79, "height": 42.43 },   // metres; width = front/back walls
  "massing": { "blocks": [                                              // optional shape; without it, a box
    { "polygon": [[0, 0], [16.05, 0], [16.05, 1.8], [18.43, 1.8], [18.43, 0], [29.39, 0], …], "height": 42.43 }
  ] },
  "facades": {
    "front": {
      "image": "assets/front.webp",                                      // relative to building.json
      "corners": { "tl": [0.2, 0.121], "tr": [0.801, 0.121], "br": [0.801, 0.92], "bl": [0.2, 0.92] },
      "relief": { "image": "data:image/png;base64,…", "depthM": 0.4, "source": "structure" } // optional depth, made by the editor
    },
    "right": { … }, "back": { … }, "left": { … }
  },
  "apartments": [
    { "id": "apt-1203", "number": "1203", "floor": 12, "status": "available",
      "rooms": 3, "areaM2": 97.8, "price": { "amountMinor": 20830000, "currency": "AZN" },
      "planImage": "assets/plans/plan-3-room.svg", "extra": { "anything": "you need" } }
  ],
  "regions": [
    { "apartmentId": "apt-1203", "facade": "front", "polygon": [[0.645, 0.1001], [1, 0.1001], [1, 0.164], [0.645, 0.164]] }
  ],
  "editor": { … }                                                        // editor-only; the widget ignores it
}
```

- **Facade order:** front, right, back, left. Walking round the building, each wall is the one to the right of the last.
- **`corners`:** where the wall's corners sit in its photo, as fractions of the image's width and height (y down). Keystoned photos are fine; the widget corrects the perspective.
- **`massing`** (optional): the building's shape as blocks, each a footprint polygon rising from
  the ground to `height`. Plan coordinates in metres: x left → right as seen from the front, d back
  from the front edge, inside `dimensions` (which stays the bounding box and the tallest height).
  A setback or a podium with a tower is two blocks. Each wall shows the photo of the side it faces,
  projected straight onto it, so a recessed wall shows the part of the photo in front of it. Walls
  hidden in their photo (a courtyard's side walls, a tower's base behind its podium) get the
  photo's average tone. Widgets without shape support show the bounding box.
- **`regions`:** an apartment's outline on one side's photo in facade coordinates: u from the left edge of that elevation to its right, v from the roof line (0) to the ground (1), as seen from outside. A corner apartment has one region on each of its two sides.
- **`relief`** (optional): a grayscale image in the wall's facade coordinates. 128 is the wall plane,
  white sticks out by `depthM` metres and black goes in by it. The widget pushes the wall surface in
  and out with it and shades it as a bump map. `source` says how the editor made it (`structure` or
  `model`). Widgets without depth support ignore it and show the wall flat.
- **`status`:** `available`, `reserved` or `sold`. Any other value is kept and shown as unavailable.
- **`price.amountMinor`:** an integer in the currency's minor unit (qəpik for AZN). Never a float.

**Compatibility.** Widgets read configs leniently: unknown fields are kept, broken apartments or
regions are skipped (with console warnings), and a newer `schemaVersion` is read best-effort.
Change the schema additively only, so widgets already embedded on live pages keep working.

## Hosting a building

Put `building.json` and the images it names in one folder and point `config-url` at the JSON:

```
buildings/123/
  building.json
  assets/front.webp  assets/right.webp  assets/back.webp  assets/left.webp
  assets/plans/plan-3-room.svg
```

If the images are on a different origin from the page, their server must send
`Access-Control-Allow-Origin` (WebGL can't use images without it). The config itself is fetched
with `credentials: 'same-origin'`.

## Using the editor

Open `editor/index.html` (or the deployed site's `editor/`). Your work autosaves in the browser.

1. **Photos.** One straight-on photo or render per wall: **Choose a folder**, pick several files, drop
   them (or the folder) anywhere on the editor, or give a file or URL per wall. Names containing front,
   right, back or left, or starting with 1–4, go on that wall; the rest fill the free walls in name
   order. Clean elevations work best: anything in front of the building (a neighbour's roof, cars,
   trees) ends up painted on the wall. (iPhone and iPad can't pick folders; choose the files instead.)
2. **Corners.** Drag the four handles onto the main wall's corners: the roof line and the ground. Use
   the same physical height on every wall so floors meet at the building's corners.
3. **Depth.** **Add depth from the photos** works depth out of each straightened photo's structure,
   instantly and offline: glass and openings sit back, opaque bands between rows of windows (slab
   edges, balcony fronts) stick out. **Refine with AI** runs a depth model (Depth Anything V2 Small)
   in the browser instead; the first time it downloads the 27 MB model from Hugging Face. Lighter
   sticks out, darker goes in. Tune **Strength** (metres) and **Smoothing** while watching the 3D
   preview, or **Remove** depth from a wall that looks wrong. Both are approximate. If you move a
   wall's corners afterwards, add its depth again.
4. **Size.** Enter the height; **Measure** derives width and depth from the photos and warns when
   opposite walls disagree by more than 5 % (usually a misplaced corner).
5. **Shape.** The building from above, front at the bottom, with each straightened photo laid along
   its side so the wall edges you see line up with the plan. Pick a template (Rectangle, L, U, T,
   Notched) and drag the corners onto those edges: they snap to 10 cm and square up with their
   neighbours (Alt places freely). Drag a + on an edge to add a corner; Delete removes the selected
   one; or type its position. **Add block** makes a second part with its own height (a tower on a
   podium, a lower wing). Rectangle goes back to the plain box. Changing the size stretches the shape.
6. **Floors.** Set the number of floors, **Space evenly**, then drag each line onto its slab. The
   lines are shared by all four walls, so check each wall.
7. **Columns.** Click a wall to split it where apartments meet; drag or remove dividers.
8. **Apartments.** Click the columns of one stack (for a corner apartment, also the column on the
   next wall), choose the floors, **Create**. Numbers follow the pattern (`{floor}{nn}` → 1203).
   Click an apartment to delete it or its whole stack.
9. **Details.** Rooms, area, price, status and plan image per apartment.

**Export JSON** downloads `building.json` (depth maps are embedded in it). Upload it with the
photos (same names, same folder).
**Open folder** (or dropping the folder) reopens an exported building with its photos, plans and
depth images in one go. **Import JSON** reopens just the file; pick the photos again if they were local.
Nothing is uploaded: folders and files are read in the browser.

## Development

| Command | |
|---|---|
| `npm run dev` | Dev server for the landing page, example host page and editor |
| `npm run build` | Static site in `dist/` and the widget in `dist/lib/` (ES + IIFE) |
| `npm run typecheck` | TypeScript, strict |
| `npm test` | Unit tests (Vitest) |
| `npm run e2e` | Browser tests (Playwright, Chromium, desktop and phone viewports); needs `npm run build` first |
| `npm run size` | Fails if the IIFE bundle passes 200 kB gzipped |
| `npm run demo:config` | Rewrites `public/demo/building.json` from `scripts/demo-config.ts` |
| `npm run demo:depth` | Recomputes the demo building's depth from the photos (after `npm run build`; needs Playwright's Chromium). `-- --ai` uses the AI model instead (needs huggingface.co; `DEPTH_MODEL_FILE=model.onnx` uses a local copy) |

```
src/core/     config schema, lenient parser, homography, wall frames, geometry, apartments
src/scene/    three.js scene: walls, overlays, picking, camera rig
src/widget/   the <abb-building-360> element, details panel, strings, mount()
src/editor/   the editor page and its grid model
demo/         example host page          editor/   editor page
scripts/      demo config generator, size check
tests/e2e/    Playwright tests
```

## Limitations of this prototype

- The building is made of blocks with flat roofs (no pitched roofs or overhangs; curves are polygons),
  and its walls are pushed in and out by depth worked out from the photos. It isn't a measured 3D
  model: steep depth changes stretch the photo on their sides, and a wall at an angle shows the photo
  of the side it faces most, stretched by the angle.
- English strings only; prices and areas already format for the `locale` you pass.
- The editor draws apartments as grid cells (floor × column). The config and widget already accept any polygon.
- No backend, accounts, reservations or spreadsheet import yet.

## Licence

All rights reserved (see `LICENSE`). The demo renders belong to their owner and are not covered
by the licence (`public/demo/assets/NOTICE.md`).
