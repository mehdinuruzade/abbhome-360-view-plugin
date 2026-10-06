import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import { deriveDimensions, quadAspect, type DimensionWarning } from '../core/dimensions';
import { facadeWidth } from '../core/facade-frame';
import { fullImageCorners, resolveUrl } from '../core/parse-config';
import { FACADES, type BuildingConfig, type Corners, type FacadeId, type UnitCell } from '../core/types';
import { BuildingScene } from '../scene/building-scene';
import '../widget/index';
import './apartment-table';
import type { ApartmentChangeDetail } from './apartment-table';
import './corner-view';
import type { CornersChangeDetail } from './corner-view';
import './facade-view';
import {
  clearDraft,
  downloadText,
  emptyImages,
  importConfig,
  loadDraft,
  saveDraft,
  serialize,
  type EditorDocument,
  type ImageRef,
} from './io';
import { loadImage } from './rectify';
import {
  addDivider,
  createUnits,
  emptyEditorData,
  levelBands,
  moveDivider,
  moveFloorLine,
  removeApartments,
  removeDivider,
  setBaseLevel,
  setEvenFloors,
  updateApartment,
  type WithEditor,
} from './state';

type Step = 'photos' | 'corners' | 'size' | 'floors' | 'columns' | 'apartments' | 'details';

const STEPS: { id: Step; label: string }[] = [
  { id: 'photos', label: 'Photos' },
  { id: 'corners', label: 'Corners' },
  { id: 'size', label: 'Size' },
  { id: 'floors', label: 'Floors' },
  { id: 'columns', label: 'Columns' },
  { id: 'apartments', label: 'Apartments' },
  { id: 'details', label: 'Details' },
];

const FACADE_LABEL: Record<FacadeId, string> = {
  front: 'Front',
  right: 'Right side',
  back: 'Back',
  left: 'Left side',
};

const DEMO_URL = '../demo/building.json';

function blankConfig(): WithEditor {
  const facade = () => ({ image: '', corners: fullImageCorners() });
  return {
    schemaVersion: 1,
    id: 'building',
    name: 'New building',
    dimensions: { width: 30, depth: 20, height: 40 },
    facades: { front: facade(), right: facade(), back: facade(), left: facade() },
    apartments: [],
    regions: [],
    editor: emptyEditorData(),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The editor page: four photos in, a building.json out. */
export class AbbEditor extends LitElement {
  static override properties = {
    _doc: { state: true },
    _step: { state: true },
    _facade: { state: true },
    _selection: { state: true },
    _levelFrom: { state: true },
    _levelTo: { state: true },
    _pattern: { state: true },
    _selectedApartment: { state: true },
    _message: { state: true },
    _warnings: { state: true },
    _invalidCorners: { state: true },
    _buyerPreview: { state: true },
  };

  declare protected _doc: EditorDocument;
  declare protected _step: Step;
  declare protected _facade: FacadeId;
  declare protected _selection: UnitCell[];
  declare protected _levelFrom: number;
  declare protected _levelTo: number;
  declare protected _pattern: string;
  declare protected _selectedApartment: string | null;
  declare protected _message: string;
  declare protected _warnings: DimensionWarning[];
  declare protected _invalidCorners: boolean;
  declare protected _buyerPreview: boolean;

  private scene: BuildingScene | null = null;
  private previewFrame = 0;
  private saveTimer = 0;

  constructor() {
    super();
    const draft = loadDraft();
    this._doc = draft ?? { config: blankConfig(), images: emptyImages() };
    this._step = 'photos';
    this._facade = 'front';
    this._selection = [];
    this._levelFrom = 1;
    this._levelTo = 1;
    this._pattern = this._doc.config.editor.numberPattern ?? '{floor}{nn}';
    this._selectedApartment = null;
    this._message = draft ? 'Restored your last draft from this browser.' : 'Start with four photos, or load the demo building.';
    this._warnings = [];
    this._invalidCorners = false;
    this._buyerPreview = false;
    this.resetLevelRange();
  }

  // ── Document plumbing ────────────────────────────────────────────────────────────────────

  private get config(): WithEditor {
    return this._doc.config;
  }

  private setConfig(config: WithEditor) {
    this._doc = { ...this._doc, config };
  }

  private setImage(f: FacadeId, image: ImageRef) {
    this._doc = { ...this._doc, images: { ...this._doc.images, [f]: image } };
  }

  /** The config with displayable image sources, for the 3D preview and the buyer preview. */
  private previewConfig(): BuildingConfig {
    const base = this._doc.baseUrl ?? document.baseURI;
    const facades = { ...this.config.facades };
    for (const f of FACADES) facades[f] = { ...facades[f], image: this._doc.images[f].src ?? '' };
    const apartments = this.config.apartments.map((a) =>
      a.planImage ? { ...a, planImage: resolveUrl(a.planImage, base) } : a,
    );
    return { ...this.config, facades, apartments };
  }

  protected override firstUpdated(): void {
    const stage = this.renderRoot.querySelector<HTMLElement>('.preview-stage');
    if (stage) {
      try {
        this.scene = new BuildingScene(stage, {
          reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
        });
        this.schedulePreview();
      } catch {
        this._message = "This browser can't show the 3D preview. You can still mark apartments and export.";
      }
    }
    void this.fillImageSizes();
  }

  protected override updated(changed: PropertyValues): void {
    if (changed.has('_doc')) {
      this.schedulePreview();
      window.clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => {
        if (!saveDraft(this._doc)) this._message = "Couldn't save a draft in this browser. Export to keep your work.";
      }, 400);
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    cancelAnimationFrame(this.previewFrame);
    this.scene?.dispose();
    this.scene = null;
  }

  private schedulePreview() {
    cancelAnimationFrame(this.previewFrame);
    this.previewFrame = requestAnimationFrame(() => {
      void this.scene?.load(this.previewConfig(), { keepCamera: true });
    });
  }

  /** Natural image sizes, needed to measure the walls' proportions. */
  private async fillImageSizes() {
    for (const f of FACADES) {
      const img = this._doc.images[f];
      if (img.src && (!img.width || !img.height)) {
        try {
          const el = await loadImage(img.src);
          this.setImage(f, { ...this._doc.images[f], width: el.naturalWidth, height: el.naturalHeight });
        } catch {
          this._message = `Couldn't load the ${FACADE_LABEL[f].toLowerCase()} photo. Choose it again in step 1.`;
        }
      }
    }
  }

  // ── Top bar actions ──────────────────────────────────────────────────────────────────────

  private newBuilding() {
    if (this.config.apartments.length && !confirm('Start a new building? This clears the current one from the editor.')) return;
    clearDraft();
    this._doc = { config: blankConfig(), images: emptyImages() };
    this._selection = [];
    this._selectedApartment = null;
    this._step = 'photos';
    this.resetLevelRange();
    this._message = 'New building. Add the four photos.';
  }

  private async loadDemo() {
    try {
      const url = new URL(DEMO_URL, document.baseURI).href;
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const { doc } = importConfig(await res.json(), url);
      this._doc = doc;
      this._pattern = doc.config.editor.numberPattern ?? '{floor}{nn}';
      this._selection = [];
      this._selectedApartment = null;
      this.resetLevelRange(doc.config);
      this._message = 'Loaded the demo building: four renders, 104 sample apartments.';
      await this.fillImageSizes();
    } catch {
      this._message = "Couldn't load the demo building.";
    }
  }

  private async importJson(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const { doc, warnings } = importConfig(JSON.parse(await file.text()));
      const missing = FACADES.filter((f) => doc.images[f].ref && !doc.images[f].src);
      this._doc = doc;
      this._pattern = doc.config.editor.numberPattern ?? '{floor}{nn}';
      this._selection = [];
      this._selectedApartment = null;
      this.resetLevelRange(doc.config);
      this._message =
        `Imported ${file.name}.` +
        (missing.length ? ` Pick the photos again in step 1 (${missing.map((f) => doc.images[f].ref).join(', ')}).` : '') +
        (warnings.length ? ` ${warnings.length} problem(s) were fixed while reading it.` : '');
      await this.fillImageSizes();
    } catch {
      this._message = "That file isn't a building config this editor can read.";
    }
  }

  private exportJson() {
    downloadText('building.json', serialize(this._doc));
    const local = FACADES.filter((f) => this._doc.images[f].src?.startsWith('blob:'));
    this._message =
      'Exported building.json.' +
      (local.length ? ` Upload it together with ${local.map((f) => this._doc.images[f].ref).join(', ')} in the same folder.` : '');
  }

  // ── Step 1: photos ───────────────────────────────────────────────────────────────────────

  private async useImage(f: FacadeId, ref: string, src: string) {
    try {
      const img = await loadImage(src);
      this.setImage(f, { ref, src, width: img.naturalWidth, height: img.naturalHeight });
      this._message = `${FACADE_LABEL[f]} photo added.`;
    } catch {
      this._message = `Couldn't open that image for the ${FACADE_LABEL[f].toLowerCase()}.`;
    }
  }

  private pickFile(f: FacadeId, e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void this.useImage(f, file.name, URL.createObjectURL(file));
  }

  /** Several files at once: matched to walls by the names in an imported config, else in name order. */
  private pickMany(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    input.value = '';
    const free = FACADES.filter((f) => !files.some((file) => file.name === this._doc.images[f].ref));
    for (const file of files) {
      const named = FACADES.find((f) => this._doc.images[f].ref === file.name);
      const f = named ?? free.shift();
      if (f) void this.useImage(f, file.name, URL.createObjectURL(file));
    }
  }

  private useUrl(f: FacadeId, e: Event) {
    const url = (e.target as HTMLInputElement).value.trim();
    if (url) void this.useImage(f, url, new URL(url, document.baseURI).href);
  }

  // ── Steps 2–3: corners and size ──────────────────────────────────────────────────────────

  private onCorners(f: FacadeId, e: CustomEvent<CornersChangeDetail>) {
    const { corners, final, valid } = e.detail;
    this._invalidCorners = !valid;
    if (!valid) return;
    if (!final) {
      this.scene?.setCorners(f, corners);
      return;
    }
    this.setCorners(f, corners);
  }

  private setCorners(f: FacadeId, corners: Corners) {
    this.setConfig({ ...this.config, facades: { ...this.config.facades, [f]: { ...this.config.facades[f], corners } } });
  }

  private aspects(): Record<FacadeId, number> | null {
    const out = {} as Record<FacadeId, number>;
    for (const f of FACADES) {
      const img = this._doc.images[f];
      if (!img.width || !img.height) return null;
      out[f] = quadAspect(this.config.facades[f].corners, img);
    }
    return out;
  }

  private measure(height = this.config.dimensions.height) {
    const aspects = this.aspects();
    if (!aspects) {
      this._message = 'Add all four photos first; their proportions give the width and depth.';
      return;
    }
    const { dimensions, warnings } = deriveDimensions(height, aspects);
    this._warnings = warnings;
    this.setConfig({
      ...this.config,
      dimensions: { width: round2(dimensions.width), depth: round2(dimensions.depth), height: round2(height) },
    });
    this._message = `Measured from the photos: ${round2(dimensions.width)} × ${round2(dimensions.depth)} × ${round2(height)} m.`;
  }

  private setDimension(key: 'width' | 'depth' | 'height', e: Event) {
    const value = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(value) || value <= 0) return;
    this.setConfig({ ...this.config, dimensions: { ...this.config.dimensions, [key]: value } });
  }

  private heightFromFloors() {
    const floors = Number((this.renderRoot.querySelector('#floors-count') as HTMLInputElement | null)?.value);
    const storey = Number((this.renderRoot.querySelector('#storey-height') as HTMLInputElement | null)?.value);
    if (!(floors > 0) || !(storey > 0)) return;
    this.measure(floors * storey);
  }

  // ── Steps 4–6: floors, columns, apartments ───────────────────────────────────────────────

  private spreadFloors() {
    const count = Number((this.renderRoot.querySelector('#band-count') as HTMLInputElement | null)?.value);
    if (!(count >= 1 && count <= 200)) return;
    const e = this.config.editor;
    const maxLevel = e.baseLevel + count - 1;
    const doomed = Object.values(e.units).filter((u) => u.level > maxLevel).length;
    if (doomed && !confirm(`${doomed} apartment(s) sit on floors that would no longer exist and will be deleted. Continue?`)) return;
    const { config } = setEvenFloors(this.config, count);
    this.setConfig(config);
    this.resetLevelRange(config);
    this._message = `${count} floors, evenly spaced. Drag any line onto its slab.`;
  }

  private resetLevelRange(config: WithEditor = this.config) {
    const levels = levelBands(config.editor).map((b) => b.level);
    if (!levels.length) return;
    const min = Math.min(...levels);
    const max = Math.max(...levels);
    this._levelFrom = levels.length > 1 ? min + 1 : min;
    this._levelTo = max;
  }

  private onFloorMove(e: CustomEvent<{ index: number; v: number }>) {
    this.setConfig(moveFloorLine(this.config, e.detail.index, e.detail.v));
  }

  private onDividerAdd(e: CustomEvent<{ u: number }>) {
    const { config, index } = addDivider(this.config, this._facade, e.detail.u);
    if (index >= 0) {
      this.setConfig(config);
      // Selected columns right of the new divider shift by one.
      this._selection = this._selection.flatMap((c) =>
        c.facade !== this._facade || c.col < index ? [c] : c.col === index ? [c, { ...c, col: index + 1 }] : [{ ...c, col: c.col + 1 }],
      );
    }
  }

  private onDividerMove(e: CustomEvent<{ index: number; u: number }>) {
    this.setConfig(moveDivider(this.config, this._facade, e.detail.index, e.detail.u));
  }

  private onDividerRemove(e: CustomEvent<{ index: number }>) {
    const index = e.detail.index;
    this.setConfig(removeDivider(this.config, this._facade, index));
    this._selection = this._selection
      .map((c) => (c.facade !== this._facade || c.col <= index ? c : { ...c, col: c.col - 1 }))
      .filter((c, i, all) => all.findIndex((x) => x.facade === c.facade && x.col === c.col) === i);
  }

  private onColumnToggle(e: CustomEvent<{ col: number }>) {
    const { col } = e.detail;
    const f = this._facade;
    const exists = this._selection.some((c) => c.facade === f && c.col === col);
    this._selection = exists ? this._selection.filter((c) => !(c.facade === f && c.col === col)) : [...this._selection, { facade: f, col }];
    this._selectedApartment = null;
  }

  private onApartmentPick(e: CustomEvent<{ id: string }>) {
    this._selectedApartment = e.detail.id;
    this._selection = [];
  }

  private create() {
    const levels: number[] = [];
    for (let l = Math.min(this._levelFrom, this._levelTo); l <= Math.max(this._levelFrom, this._levelTo); l++) levels.push(l);
    const { config, created, skippedLevels } = createUnits(this.config, {
      cells: this._selection,
      levels,
      pattern: this._pattern || undefined,
    });
    this.setConfig({ ...config, editor: { ...config.editor, numberPattern: this._pattern || config.editor.numberPattern } });
    const numbers = created.map((id) => config.apartments.find((a) => a.id === id)?.number);
    this._message =
      created.length > 0
        ? `Created ${created.length} apartment${created.length === 1 ? '' : 's'}: ${numbers[0]}${created.length > 1 ? ` … ${numbers[numbers.length - 1]}` : ''}.`
        : 'Nothing created.';
    if (skippedLevels.length) this._message += ` Skipped floor(s) ${skippedLevels.join(', ')}: some of those cells already belong to an apartment.`;
    this._selection = [];
  }

  private deleteApartment(stack: boolean) {
    const id = this._selectedApartment;
    if (!id) return;
    const unit = this.config.editor.units[id];
    const key = (cells: UnitCell[]) => cells.map((c) => `${c.facade}:${c.col}`).sort().join('|');
    const ids =
      stack && unit
        ? Object.entries(this.config.editor.units)
            .filter(([, u]) => key(u.cells) === key(unit.cells))
            .map(([other]) => other)
        : [id];
    this.setConfig(removeApartments(this.config, ids));
    this._selectedApartment = null;
    this._message = `Deleted ${ids.length} apartment${ids.length === 1 ? '' : 's'}.`;
  }

  // ── Rendering ────────────────────────────────────────────────────────────────────────────

  protected override render() {
    return html`
      <header class="bar">
        <div class="title">
          <a href="../index.html">Building 360</a>
          <strong>Editor</strong>
        </div>
        <div class="actions">
          <button type="button" @click=${this.newBuilding}>New</button>
          <button type="button" @click=${this.loadDemo}>Load demo</button>
          <label class="button">Import JSON<input type="file" accept="application/json,.json" @change=${this.importJson} hidden /></label>
          <button type="button" @click=${this.exportJson}>Export JSON</button>
          <button type="button" class="primary" @click=${() => (this._buyerPreview = true)}>Preview as buyer</button>
        </div>
      </header>
      <div class="layout">
        <nav class="steps" aria-label="Steps">
          ${STEPS.map(
            (s, i) => html`<button type="button" class=${s.id === this._step ? 'step current' : 'step'} aria-current=${s.id === this._step ? 'step' : 'false'}
              @click=${() => (this._step = s.id)}><span>${i + 1}</span>${s.label}</button>`,
          )}
        </nav>
        <section class="work">${this.renderStep()}</section>
        <aside class="preview">
          <div class="preview-stage"></div>
          <p class="caption">Live 3D preview · drag to rotate</p>
        </aside>
      </div>
      <footer class="status" role="status">${this._message}</footer>
      ${this._buyerPreview ? this.renderBuyerPreview() : nothing}
    `;
  }

  private renderFacadeTabs() {
    return html`<div class="tabs" role="tablist">
      ${FACADES.map(
        (f, i) => html`<button type="button" role="tab" aria-selected=${f === this._facade} class=${f === this._facade ? 'tab current' : 'tab'}
          @click=${() => (this._facade = f)}>${i + 1} · ${FACADE_LABEL[f]}</button>`,
      )}
    </div>`;
  }

  private renderStep() {
    switch (this._step) {
      case 'photos':
        return this.renderPhotos();
      case 'corners':
        return this.renderCorners();
      case 'size':
        return this.renderSize();
      case 'floors':
      case 'columns':
      case 'apartments':
        return this.renderGrid(this._step);
      case 'details':
        return this.renderDetails();
    }
  }

  private renderPhotos() {
    return html`
      <h2>1. Photos of the four walls</h2>
      <p class="help">
        Straight-on (90°) photos or renders. Walk round the building: each next photo is the wall to the right of the last.
        Photos stay in this browser until you export.
      </p>
      <label class="button">Choose all four at once<input type="file" accept="image/*" multiple @change=${this.pickMany} hidden /></label>
      <div class="photo-grid">
        ${FACADES.map((f, i) => {
          const img = this._doc.images[f];
          return html`<div class="photo">
            <div class="thumb">${img.src ? html`<img src=${img.src} alt=${`${FACADE_LABEL[f]} photo`} />` : html`<span>${img.ref ? `Pick ${img.ref} again` : 'No photo yet'}</span>`}</div>
            <strong>${i + 1}. ${FACADE_LABEL[f]}</strong>
            <label class="button small">Choose file<input type="file" accept="image/*" @change=${(e: Event) => this.pickFile(f, e)} hidden /></label>
            <input type="url" placeholder="or paste an image URL" aria-label=${`${FACADE_LABEL[f]} image URL`} @change=${(e: Event) => this.useUrl(f, e)} />
            ${img.ref ? html`<span class="ref">${img.ref}</span>` : nothing}
          </div>`;
        })}
      </div>
      <svg class="walk" viewBox="-12 0 184 120" role="img" aria-label="Order of the photos seen from above: front, right, back, left">
        <rect x="45" y="30" width="70" height="60" rx="4" fill="#e3e7eb" stroke="#5b6673" />
        <text x="80" y="108" text-anchor="middle">1 Front</text>
        <text x="146" y="64" text-anchor="middle">2 Right</text>
        <text x="80" y="20" text-anchor="middle">3 Back</text>
        <text x="16" y="64" text-anchor="middle">4 Left</text>
        <path d="M100 98 Q130 96 128 76" fill="none" stroke="#1d6feb" marker-end="url(#arrow)" />
        <defs><marker id="arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 6 3 0 6z" fill="#1d6feb" /></marker></defs>
      </svg>
    `;
  }

  private renderCorners() {
    const f = this._facade;
    return html`
      <h2>2. Wall corners</h2>
      <p class="help">
        Drag the four handles onto the corners of the main wall: the roof line at the top, the ground at the bottom. Use the
        same physical height on every wall, so floors line up at the building's corners. Arrow keys nudge a focused handle.
      </p>
      ${this.renderFacadeTabs()}
      <abb360-corner-view
        .src=${this._doc.images[f].src ?? ''}
        .corners=${this.config.facades[f].corners}
        @corners-change=${(e: CustomEvent<CornersChangeDetail>) => this.onCorners(f, e)}
      ></abb360-corner-view>
      <button type="button" @click=${() => this.setCorners(f, fullImageCorners())}>Use the whole image</button>
    `;
  }

  private renderSize() {
    const d = this.config.dimensions;
    return html`
      <h2>3. Size</h2>
      <p class="help">Enter the height. Width and depth come from the walls' proportions in the photos; correct them if you know better.</p>
      <div class="form-grid">
        <label>Height (m)<input id="height" type="number" min="1" step="0.1" .value=${String(d.height)} @change=${(e: Event) => this.setDimension('height', e)} /></label>
        <label>Width, front and back (m)<input type="number" min="1" step="0.1" .value=${String(d.width)} @change=${(e: Event) => this.setDimension('width', e)} /></label>
        <label>Depth, sides (m)<input type="number" min="1" step="0.1" .value=${String(d.depth)} @change=${(e: Event) => this.setDimension('depth', e)} /></label>
      </div>
      <p><button type="button" class="primary" @click=${() => this.measure()}>Measure width and depth from the photos</button></p>
      <details>
        <summary>Height from floors instead</summary>
        <div class="form-grid">
          <label>Floors<input id="floors-count" type="number" min="1" step="1" value="14" /></label>
          <label>Storey height (m)<input id="storey-height" type="number" min="2" step="0.05" value="3" /></label>
        </div>
        <button type="button" @click=${this.heightFromFloors}>Use floors × storey height</button>
      </details>
      ${this._warnings.map(
        (w) => html`<p class="warning" role="alert">
          ${w.code === 'width-mismatch' ? 'Front and back' : 'Left and right'} disagree by ${Math.round(w.difference * 100)} %.
          Check that the corners on those walls are at the same roof line and ground.
        </p>`,
      )}
    `;
  }

  private renderGrid(mode: 'floors' | 'columns' | 'apartments') {
    const f = this._facade;
    const e = this.config.editor;
    const bands = levelBands(e);
    const aspect = facadeWidth(f, this.config.dimensions) / this.config.dimensions.height;
    const selectedApartment = this._selectedApartment ? this.config.apartments.find((a) => a.id === this._selectedApartment) : undefined;
    const help = {
      floors: 'Drag the yellow handles onto the floor slabs. The lines are shared by all four walls: check each wall.',
      columns: "Click the wall to split it where apartments meet. Drag a blue handle to adjust; × removes a divider.",
      apartments:
        'Click the columns of one stack (for a corner apartment, also the column on the next wall), pick the floors, then create. Click an existing apartment to delete it.',
    }[mode];
    return html`
      <h2>${{ floors: '4. Floors', columns: '5. Columns', apartments: '6. Apartments' }[mode]}</h2>
      <p class="help">${help}</p>
      ${mode === 'floors'
        ? html`<div class="inline-form">
            <label>Floors<input id="band-count" type="number" min="1" max="200" .value=${String(bands.length)} /></label>
            <button type="button" @click=${this.spreadFloors}>Space evenly</button>
            <label>Bottom floor is number<input type="number" step="1" .value=${String(e.baseLevel)}
              @change=${(ev: Event) => this.setConfig(setBaseLevel(this.config, Number((ev.target as HTMLInputElement).value) || 0))} /></label>
          </div>`
        : nothing}
      ${mode === 'apartments' ? this.renderCreateForm(bands.map((b) => b.level), selectedApartment?.number) : nothing}
      ${this.renderFacadeTabs()}
      <abb360-facade-view
        .src=${this._doc.images[f].src ?? ''}
        .corners=${this.config.facades[f].corners}
        .aspect=${aspect}
        .facade=${f}
        .mode=${mode}
        .editor=${e}
        .apartments=${this.config.apartments}
        .regions=${this.config.regions}
        .selectedCells=${this._selection}
        .levelRange=${[this._levelFrom, this._levelTo] as [number, number]}
        .selectedApartment=${this._selectedApartment}
        @floor-move=${this.onFloorMove}
        @divider-add=${this.onDividerAdd}
        @divider-move=${this.onDividerMove}
        @divider-remove=${this.onDividerRemove}
        @column-toggle=${this.onColumnToggle}
        @apartment-pick=${this.onApartmentPick}
      ></abb360-facade-view>
    `;
  }

  private renderCreateForm(levels: number[], selectedNumber: string | undefined) {
    if (selectedNumber) {
      return html`<div class="inline-form">
        <span>Apartment <strong>${selectedNumber}</strong> selected.</span>
        <button type="button" @click=${() => this.deleteApartment(false)}>Delete apartment</button>
        <button type="button" @click=${() => this.deleteApartment(true)}>Delete its whole stack</button>
        <button type="button" @click=${() => (this._selectedApartment = null)}>Done</button>
      </div>`;
    }
    const cells = this._selection.map((c) => `${FACADE_LABEL[c.facade]} column ${c.col + 1}`).join(', ');
    const min = levels.length ? Math.min(...levels) : 0;
    const max = levels.length ? Math.max(...levels) : 0;
    return html`<div class="inline-form">
      <span class="selection">${cells || 'No columns selected'}</span>
      <label>Floors from<input id="level-from" type="number" min=${min} max=${max} .value=${String(this._levelFrom)}
        @change=${(e: Event) => (this._levelFrom = Number((e.target as HTMLInputElement).value))} /></label>
      <label>to<input id="level-to" type="number" min=${min} max=${max} .value=${String(this._levelTo)}
        @change=${(e: Event) => (this._levelTo = Number((e.target as HTMLInputElement).value))} /></label>
      <label>Numbers<input id="pattern" .value=${this._pattern} title="{floor} = floor number, {nn} = position on the floor"
        @change=${(e: Event) => (this._pattern = (e.target as HTMLInputElement).value)} /></label>
      <button type="button" class="primary" ?disabled=${this._selection.length === 0} @click=${this.create}>Create apartments</button>
      ${this._selection.length ? html`<button type="button" @click=${() => (this._selection = [])}>Clear</button>` : nothing}
    </div>`;
  }

  private renderDetails() {
    return html`
      <h2>7. Apartment details</h2>
      <p class="help">Rooms, area, price and status for each apartment. The host site can also push live status and prices to the widget.</p>
      <abb360-apartment-table
        .apartments=${this.config.apartments}
        .selected=${this._selectedApartment}
        @apartment-change=${(e: CustomEvent<ApartmentChangeDetail>) => this.setConfig(updateApartment(this.config, e.detail.id, e.detail.patch))}
        @apartment-delete=${(e: CustomEvent<{ id: string }>) => this.setConfig(removeApartments(this.config, [e.detail.id]))}
      ></abb360-apartment-table>
    `;
  }

  private renderBuyerPreview() {
    return html`<div class="modal" role="dialog" aria-label="Buyer preview" @click=${(e: Event) => e.target === e.currentTarget && (this._buyerPreview = false)}>
      <div class="modal-body">
        <div class="modal-head">
          <strong>What buyers see</strong>
          <button type="button" @click=${() => (this._buyerPreview = false)}>Close</button>
        </div>
        <abb-building-360 .config=${this.previewConfig()}></abb-building-360>
      </div>
    </div>`;
  }

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      color: #1d2733;
      background: #f3f5f7;
      font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    }
    * {
      box-sizing: border-box;
    }
    button,
    .button {
      display: inline-flex;
      align-items: center;
      min-height: 34px;
      padding: 6px 12px;
      border: 1px solid #ccd3da;
      border-radius: 8px;
      background: #fff;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    button:hover,
    .button:hover {
      border-color: #1d2733;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .primary {
      background: #1d2733;
      border-color: #1d2733;
      color: #fff;
    }
    .small {
      min-height: 28px;
      padding: 2px 10px;
      font-size: 13px;
    }
    input {
      padding: 6px 8px;
      border: 1px solid #ccd3da;
      border-radius: 6px;
      font: inherit;
    }
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 16px;
      border-bottom: 1px solid #dde2e7;
      background: #fff;
    }
    .title {
      display: flex;
      gap: 10px;
      align-items: baseline;
    }
    .title a {
      color: #5b6673;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .layout {
      flex: 1;
      display: grid;
      grid-template-columns: 170px minmax(0, 1fr) minmax(280px, 30%);
      gap: 16px;
      padding: 16px;
    }
    @media (max-width: 1000px) {
      .layout {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    .steps {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    @media (max-width: 1000px) {
      .steps {
        flex-direction: row;
        flex-wrap: wrap;
      }
    }
    .step {
      justify-content: flex-start;
      gap: 8px;
      border-color: transparent;
      background: transparent;
    }
    .step span {
      display: inline-grid;
      place-items: center;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: #e3e7eb;
      font-size: 12px;
    }
    .step.current {
      border-color: #ccd3da;
      background: #fff;
      font-weight: 600;
    }
    .step.current span {
      background: #1d2733;
      color: #fff;
    }
    .work {
      min-width: 0;
      padding: 16px;
      border: 1px solid #dde2e7;
      border-radius: 12px;
      background: #fff;
    }
    .work h2 {
      margin: 0 0 4px;
      font-size: 18px;
    }
    .help {
      margin: 0 0 12px;
      color: #5b6673;
    }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 8px 0 12px;
    }
    .tab.current {
      background: #1d2733;
      border-color: #1d2733;
      color: #fff;
    }
    .photo-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 12px;
      margin: 12px 0;
    }
    .photo {
      display: grid;
      gap: 6px;
      align-content: start;
    }
    .photo input[type='url'] {
      width: 100%;
    }
    .thumb {
      display: grid;
      place-items: center;
      aspect-ratio: 1;
      overflow: hidden;
      border: 1px dashed #ccd3da;
      border-radius: 8px;
      background: #f3f5f7;
      color: #5b6673;
      font-size: 12px;
      text-align: center;
    }
    .thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .ref {
      color: #5b6673;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .walk {
      width: 200px;
      font-size: 10px;
      fill: #1d2733;
    }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 12px;
      margin: 8px 0;
    }
    .form-grid label,
    .inline-form label {
      display: grid;
      gap: 4px;
      font-size: 13px;
      color: #5b6673;
    }
    .inline-form {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: 10px;
      margin: 8px 0;
    }
    .inline-form input {
      width: 110px;
    }
    .selection {
      align-self: center;
      color: #1d2733;
      font-weight: 600;
    }
    .warning {
      padding: 8px 12px;
      border-radius: 8px;
      background: #fff4e5;
      color: #8a4b00;
    }
    abb360-facade-view {
      padding: 20px 0 0 34px;
    }
    .preview {
      position: sticky;
      top: 16px;
      align-self: start;
    }
    .preview-stage {
      position: relative;
      aspect-ratio: 3 / 4;
      overflow: hidden;
      border-radius: 12px;
      background: linear-gradient(180deg, #cfdbe6 0%, #e9eef2 55%, #f3f4f2 100%);
    }
    .caption {
      margin: 6px 0 0;
      color: #5b6673;
      font-size: 12px;
      text-align: center;
    }
    .status {
      padding: 8px 16px;
      border-top: 1px solid #dde2e7;
      background: #fff;
      color: #5b6673;
      min-height: 38px;
    }
    .modal {
      position: fixed;
      inset: 0;
      z-index: 10;
      display: grid;
      place-items: center;
      padding: 16px;
      background: rgb(15 20 25 / 0.55);
    }
    .modal-body {
      width: min(1000px, 100%);
      padding: 12px;
      border-radius: 14px;
      background: #fff;
    }
    .modal-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
  `;
}

if (!customElements.get('abb360-editor')) customElements.define('abb360-editor', AbbEditor);
