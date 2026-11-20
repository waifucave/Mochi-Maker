/**
 * The physics dialog (Modeling › Physics…): the physics settings ("groups")
 * of the model, each with its inputs, its pendulum and its outputs, a live test with Mochi2D's
 * physics in the View area, and the outputs' observed peaks with a rescale to 100 %. Every change
 * is a `physics.*` command; testing is a view setting.
 */
import type { LintResult as Lint, Parameter, PhysicsSetting, Uid } from '@mochi-maker/core';
import { lint } from '@mochi-maker/core';
import { round, type Editor } from './editor.js';
import { fill, h } from './dom.js';
import { dialog, type Dialog } from './dialogs.js';
import type { Tips } from './tips.js';
import type { Viewport } from './viewport.js';

type Fields = Omit<PhysicsSetting, 'kind' | 'uid'>;
type Particle = PhysicsSetting['particles'][number];

/** Pendulum presets (our own values): the chain from the root, x and y in normalized units. */
export const PENDULUM_PRESETS: Record<string, Particle[]> = {
  'One stage': [
    { x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 },
    { x: 0, y: 10, mobility: 0.95, delay: 0.9, acceleration: 1.5, radius: 10 },
  ],
  'Two stages': [
    { x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 },
    { x: 0, y: 8, mobility: 0.95, delay: 0.85, acceleration: 1.5, radius: 8 },
    { x: 0, y: 16, mobility: 0.9, delay: 0.8, acceleration: 1.5, radius: 8 },
  ],
  'Three stages (long hair)': [
    { x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 },
    { x: 0, y: 6, mobility: 0.95, delay: 0.85, acceleration: 1.2, radius: 6 },
    { x: 0, y: 12, mobility: 0.92, delay: 0.8, acceleration: 1.4, radius: 6 },
    { x: 0, y: 18, mobility: 0.9, delay: 0.75, acceleration: 1.6, radius: 6 },
  ],
};

/** Input presets (our own): standard parameter IDs that drive sway, used when the model has them. */
export const INPUT_PRESETS: Record<
  string,
  { id: string; type: 'X' | 'Y' | 'Angle'; weight: number }[]
> = {
  None: [],
  Head: [
    { id: 'ParamAngleX', type: 'X', weight: 60 },
    { id: 'ParamAngleZ', type: 'Angle', weight: 60 },
  ],
  Body: [
    { id: 'ParamBodyAngleX', type: 'X', weight: 40 },
    { id: 'ParamBodyAngleZ', type: 'Angle', weight: 40 },
  ],
  'Head and body': [
    { id: 'ParamAngleX', type: 'X', weight: 60 },
    { id: 'ParamAngleZ', type: 'Angle', weight: 60 },
    { id: 'ParamBodyAngleX', type: 'X', weight: 40 },
    { id: 'ParamBodyAngleZ', type: 'Angle', weight: 40 },
  ],
};

const NORMALIZATION = {
  position: { min: -10, default: 0, max: 10 },
  angle: { min: -10, default: 0, max: 10 },
};

/** Observed values of a parameter while testing. */
interface Peak {
  min: number;
  max: number;
}

export class PhysicsDialog {
  private d: Dialog | null = null;
  private current: Uid | null = null;
  private readonly peaks = new Map<Uid, Peak>();
  private raf = 0;
  private readonly body = h('div.physics');
  private readonly peakEls = new Map<Uid, HTMLElement>();

  constructor(
    private readonly editor: Editor,
    private readonly viewport: Viewport,
    private readonly tips: Tips,
  ) {
    editor.on('document', (e) => {
      if (
        this.d &&
        e.changes.some(
          (c) => c.kind === 'physicsSetting' || c.kind === 'project' || c.kind === 'parameter',
        )
      )
        this.render();
    });
    editor.on('project', () => {
      this.current = null;
      this.peaks.clear();
      this.render();
    });
  }

  get isOpen(): boolean {
    return this.d !== null;
  }

  open(): void {
    if (this.d) return;
    this.d = dialog('Physics', [this.body], {
      modal: false,
      wide: true,
      testid: 'physics',
      onClose: () => {
        this.d = null;
        this.setTest(false);
      },
    });
    this.d.el.classList.add('physics-dialog');
    this.render();
    this.tips.tip(
      'physics-save',
      'Physics settings are part of the model: save the model to keep them.',
    );
  }

  close(): void {
    this.d?.close();
  }

  private get settings(): PhysicsSetting[] {
    const v = this.editor.view;
    return v.project().physicsOrder.map((u) => v.getAs(u, 'physicsSetting'));
  }

  private params(): Parameter[] {
    const v = this.editor.view;
    return v.project().parameterOrder.map((u) => v.getAs(u, 'parameter'));
  }

  private fields(s: PhysicsSetting): Fields {
    return structuredClone({
      name: s.name,
      inputs: s.inputs,
      outputs: s.outputs,
      particles: s.particles,
      normalization: s.normalization,
    });
  }

  /** Writes a setting's fields as one command. */
  private update(s: PhysicsSetting, change: (f: Fields) => void, label = 'Edit physics'): void {
    const f = this.fields(s);
    change(f);
    this.editor.transact(label, [{ name: 'physics.updateSetting', args: { target: s.uid, ...f } }]);
  }

  /** Adds a group: a name, an input preset and a pendulum preset (step 2). */
  add(name: string, inputs = 'None', pendulum = 'One stage'): Uid | null {
    const byId = new Map(this.params().map((p) => [p.exportId, p.uid]));
    const r = this.editor.transact('Add physics', [
      {
        name: 'physics.addSetting',
        args: {
          name,
          inputs: (INPUT_PRESETS[inputs] ?? [])
            .filter((x) => byId.has(x.id))
            .map((x) => ({
              parameter: byId.get(x.id)!,
              type: x.type,
              weight: x.weight,
              reflect: false,
            })),
          outputs: [],
          particles: structuredClone(PENDULUM_PRESETS[pendulum] ?? PENDULUM_PRESETS['One stage']!),
          normalization: structuredClone(NORMALIZATION),
        },
      },
    ]);
    const uid = (r?.results[0] as { uid?: Uid } | undefined)?.uid ?? null;
    if (uid) this.current = uid;
    this.render();
    return uid;
  }

  // ---------------------------------------------------------------- testing

  /** The live test: Mochi2D's physics in the View area, and the outputs' peaks. */
  setTest(on: boolean): void {
    this.viewport.setSimulate(on);
    cancelAnimationFrame(this.raf);
    if (!on) return;
    const tick = () => {
      if (!this.viewport.simulate) return;
      this.sample();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.render();
  }

  /** Reads the outputs' values from the model shown, and widens their observed ranges. */
  sample(): void {
    const model = this.viewport.model;
    if (!model) return;
    const v = this.editor.view;
    for (const s of this.settings)
      for (const o of s.outputs) {
        const p = v.get(o.parameter);
        if (p?.kind !== 'parameter') continue;
        const x = model.getParameter(p.exportId);
        if (typeof x !== 'number' || !Number.isFinite(x)) continue;
        const k = this.peaks.get(p.uid) ?? { min: p.default, max: p.default };
        k.min = Math.min(k.min, x);
        k.max = Math.max(k.max, x);
        this.peaks.set(p.uid, k);
        const el = this.peakEls.get(p.uid);
        if (el) el.textContent = this.peakText(p);
      }
  }

  /** The observed peak above and below the default, as percentages of the range on that side. */
  peakOf(p: Parameter): { above: number; below: number } {
    const k = this.peaks.get(p.uid);
    if (!k) return { above: 0, below: 0 };
    return {
      above: p.max > p.default ? (100 * (k.max - p.default)) / (p.max - p.default) : 0,
      below: p.default > p.min ? (100 * (p.default - k.min)) / (p.default - p.min) : 0,
    };
  }

  private peakText(p: Parameter): string {
    const { above, below } = this.peakOf(p);
    return `↑ ${Math.round(above)} % · ↓ ${Math.round(below)} %`;
  }

  /** Rescales an output so its observed peak on one side reaches 100 % of the range. */
  rescale(s: PhysicsSetting, i: number, side: 'above' | 'below'): void {
    const o = s.outputs[i]!;
    const p = this.editor.view.getAs(o.parameter, 'parameter');
    const peak = this.peakOf(p)[side];
    if (!(peak > 0.01)) {
      this.editor.emit('message', {
        level: 'error',
        text: `No peak observed ${side} the default yet: test the physics first.`,
      });
      return;
    }
    this.update(
      s,
      (f) => (f.outputs[i]!.scale = Math.round(o.scale * (100 / peak) * 1000) / 1000),
      'Rescale output',
    );
    this.peaks.delete(p.uid);
  }

  /**
   * The input pad: dragging it drives the selected group's input parameters, horizontally for X and
   * Angle inputs and vertically for Y inputs, across their ranges; releasing returns them to their
   * defaults, so the pendulum settles.
   */
  private pad(s: PhysicsSetting): HTMLElement {
    const pad = h('div.physics-pad', {
      dataset: { testid: 'physics-pad' },
      title: 'Drag to move the inputs',
    });
    const dot = h('span.pad-dot');
    pad.append(dot);
    const v = this.editor.view;
    const set = (fx: number, fy: number) => {
      for (const i of s.inputs) {
        const p = v.get(i.parameter);
        if (p?.kind !== 'parameter') continue;
        const f = i.type === 'Y' ? fy : fx;
        const value =
          f >= 0 ? p.default + f * (p.max - p.default) : p.default + f * (p.default - p.min);
        this.editor.setPoseRaw(p.uid, value);
      }
      dot.style.left = `${50 + 50 * fx}%`;
      dot.style.top = `${50 - 50 * fy}%`;
    };
    pad.addEventListener('pointerdown', (e) => {
      pad.setPointerCapture(e.pointerId);
      if (!this.viewport.simulate) {
        this.setTest(true);
        this.render();
      }
      const move = (m: PointerEvent) => {
        const r = pad.getBoundingClientRect();
        const fx = Math.max(-1, Math.min(1, ((m.clientX - r.left) / r.width) * 2 - 1));
        const fy = Math.max(-1, Math.min(1, 1 - ((m.clientY - r.top) / r.height) * 2));
        set(fx, fy);
      };
      move(e);
      const up = () => {
        pad.removeEventListener('pointermove', move);
        pad.removeEventListener('pointerup', up);
        set(0, 0);
      };
      pad.addEventListener('pointermove', move);
      pad.addEventListener('pointerup', up);
    });
    return pad;
  }

  // ---------------------------------------------------------------- rendering

  render(): void {
    if (!this.d) return;
    const settings = this.settings;
    if (this.current && !settings.some((s) => s.uid === this.current)) this.current = null;
    this.current ??= settings[0]?.uid ?? null;
    const s = settings.find((x) => x.uid === this.current);
    const project = this.editor.view.project();
    const newName = h('input', {
      placeholder: 'Name',
      value: `Physics ${settings.length + 1}`,
      dataset: { testid: 'physics-new-name' },
    });
    const inPreset = h(
      'select',
      { dataset: { testid: 'physics-new-inputs' } },
      Object.keys(INPUT_PRESETS).map((k) => h('option', k)),
    );
    const penPreset = h(
      'select',
      { dataset: { testid: 'physics-new-pendulum' } },
      Object.keys(PENDULUM_PRESETS).map((k) => h('option', k)),
    );
    const problems = lint(this.editor.view).filter(
      (l: Lint) =>
        l.rule.startsWith('physics-') &&
        (l.uid === s?.uid || s?.outputs.some((o) => o.parameter === l.uid)),
    );
    fill(
      this.body,
      h(
        'div.physics-groups',
        h('h3', 'Groups'),
        settings.map((x) =>
          h(
            'div.row',
            {
              class: x.uid === this.current ? 'selected' : '',
              dataset: { physics: x.name },
              on: { click: () => ((this.current = x.uid), this.render()) },
            },
            h('input', {
              type: 'checkbox',
              title: 'Include in the test',
              checked: !this.editor.physicsMuted.has(x.uid),
              dataset: { testid: `physics-on-${x.name}` },
              on: {
                click: (e) => e.stopPropagation(),
                change: (e) => {
                  if ((e.target as HTMLInputElement).checked)
                    this.editor.physicsMuted.delete(x.uid);
                  else this.editor.physicsMuted.add(x.uid);
                  this.editor.emit('viewState', undefined);
                },
              },
            }),
            h('span.name', x.name),
            h('span.extra', `${x.inputs.length} in · ${x.outputs.length} out`),
          ),
        ),
        settings.length
          ? null
          : h('div.empty', 'No physics yet. Key the sway parameters first, then add a group.'),
        h(
          'div.field-col',
          newName,
          h('label.field', h('span', 'Inputs'), inPreset),
          h('label.field', h('span', 'Pendulum'), penPreset),
        ),
        h(
          'div.buttons',
          h(
            'button.primary',
            {
              dataset: { testid: 'physics-add' },
              on: {
                click: () => this.add(newName.value || 'Physics', inPreset.value, penPreset.value),
              },
            },
            'Add group',
          ),
          h(
            'button.danger',
            {
              disabled: !s,
              on: {
                click: () =>
                  s &&
                  this.editor.transact('Remove physics', [
                    { name: 'physics.removeSetting', args: { target: s.uid } },
                  ]),
              },
            },
            'Remove',
          ),
        ),
        this.importButton(),
        h(
          'label.field',
          { title: 'Steps per second of the simulation (0: one step per frame)' },
          h('span', 'Frame rate'),
          h('input', {
            type: 'number',
            min: '0',
            value: String(project.physicsFps),
            dataset: { testid: 'physics-fps' },
            on: {
              change: (e) =>
                this.editor.transact('Physics frame rate', [
                  {
                    name: 'physics.setFps',
                    args: { fps: Number((e.target as HTMLInputElement).value) || 0 },
                  },
                ]),
            },
          }),
        ),
        h(
          'div.physics-test',
          h(
            'label.toggle',
            h('input', {
              type: 'checkbox',
              checked: this.viewport.simulate,
              dataset: { testid: 'physics-test' },
              on: { change: (e) => this.setTest((e.target as HTMLInputElement).checked) },
            }),
            'Test (run physics in the View area)',
          ),
          s ? this.pad(s) : null,
          h(
            'div.hint',
            'Drag the pad, move the input parameters, or play a motion. Release to let it settle.',
          ),
          h('button', { on: { click: () => (this.peaks.clear(), this.render()) } }, 'Reset peaks'),
        ),
      ),
      s
        ? this.editorFor(s, problems)
        : h('div.physics-edit', h('div.empty', 'Add a group to edit it.')),
    );
  }

  /**
   * «Import .physics3.json…»: a physics file made elsewhere, through `physics.import`.
   * Its report says what was added and replaced, and which inputs and outputs found no parameter.
   */
  private importButton(): HTMLElement {
    const file = h('input', {
      type: 'file',
      accept: '.json',
      hidden: true,
      dataset: { testid: 'physics-import-file' },
    });
    const report = h('div.facts', { dataset: { testid: 'physics-import-report' } });
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      void f.text().then(async (text) => {
        const r = await this.editor.runItems(`Import ${f.name}`, [
          { name: 'physics.import', args: { text } },
        ]);
        const res = r?.itemResults[0] as
          | {
              added: string[];
              replaced: string[];
              unmatched: { setting: string; kind: string; parameter: string }[];
            }
          | undefined;
        if (!res) return;
        this.render();
        const el = this.body.querySelector<HTMLElement>('[data-testid="physics-import-report"]');
        if (el)
          el.textContent = [
            `${f.name}: ${res.added.length} group(s) added, ${res.replaced.length} replaced.`,
            ...res.unmatched.map(
              (u) =>
                `${u.setting}: ${u.kind} ${u.parameter} has no parameter here and was left out.`,
            ),
          ].join(' ');
      });
    });
    return h(
      'div.physics-import',
      h(
        'button',
        {
          title:
            'Add the groups of a physics file made elsewhere; groups of the same name are replaced',
          dataset: { testid: 'physics-import' },
          on: { click: () => file.click() },
        },
        'Import .physics3.json…',
      ),
      file,
      report,
    );
  }

  private editorFor(s: PhysicsSetting, problems: Lint[]): HTMLElement {
    const params = this.params();
    this.peakEls.clear();
    const paramSelect = (value: Uid, change: (u: Uid) => void, testid: string) =>
      h(
        'select',
        {
          dataset: { testid },
          on: { change: (e) => change((e.target as HTMLSelectElement).value) },
        },
        params.map((p) =>
          h(
            'option',
            { value: p.uid, selected: p.uid === value },
            p.name ? `${p.name} (${p.exportId})` : p.exportId,
          ),
        ),
      );
    const typeSelect = (value: string, change: (t: 'X' | 'Y' | 'Angle') => void) =>
      h(
        'select',
        {
          on: {
            change: (e) => change((e.target as HTMLSelectElement).value as 'X' | 'Y' | 'Angle'),
          },
        },
        [
          ['X', 'Sideways (X)'],
          ['Y', 'Up and down (Y)'],
          ['Angle', 'Angle'],
        ].map(([t, l]) => h('option', { value: t, selected: t === value }, l)),
      );
    const num = (value: number, change: (n: number) => void, testid?: string, step = 'any') =>
      h('input.num', {
        type: 'number',
        step,
        value: String(round(value, 4)),
        dataset: testid ? { testid } : {},
        on: {
          change: (e) => {
            const n = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(n)) change(n);
          },
        },
      });
    const check = (value: boolean, change: (b: boolean) => void) =>
      h('input', {
        type: 'checkbox',
        checked: value,
        on: { change: (e) => change((e.target as HTMLInputElement).checked) },
      });
    const remove = (what: 'inputs' | 'outputs' | 'particles', i: number) =>
      h(
        'button.step',
        {
          title: 'Remove',
          disabled: what === 'particles' && s.particles.length <= 1,
          on: {
            click: () =>
              this.update(s, (f) => {
                (f[what] as unknown[]).splice(i, 1);
                if (what === 'particles')
                  for (const o of f.outputs)
                    o.particle = Math.min(o.particle, f.particles.length - 1);
              }),
          },
        },
        '×',
      );
    const name = h('input', { value: s.name, dataset: { testid: 'physics-name' } });
    name.addEventListener('change', () =>
      this.update(s, (f) => (f.name = name.value || f.name), 'Rename physics'),
    );
    const firstParam = params[0]?.uid;
    const outputRows = s.outputs.map((o, i) => {
      const p = this.editor.view.get(o.parameter) as Parameter | undefined;
      const peak = p ? this.peakOf(p) : { above: 0, below: 0 };
      const peakEl = h(
        'span.peak',
        {
          class: peak.above > 100 || peak.below > 100 ? 'warn' : '',
          dataset: { testid: `peak-${i}` },
        },
        p ? this.peakText(p) : '',
      );
      if (p) this.peakEls.set(p.uid, peakEl);
      return h(
        'tr',
        h(
          'td',
          paramSelect(
            o.parameter,
            (u) => this.update(s, (f) => (f.outputs[i]!.parameter = u)),
            `output-param-${i}`,
          ),
        ),
        h(
          'td',
          h(
            'select',
            {
              dataset: { testid: `output-particle-${i}` },
              on: {
                change: (e) =>
                  this.update(
                    s,
                    (f) => (f.outputs[i]!.particle = Number((e.target as HTMLSelectElement).value)),
                  ),
              },
            },
            s.particles.map((_, k) =>
              h(
                'option',
                { value: String(k), selected: k === o.particle },
                k === 0 ? 'root' : `stage ${k}`,
              ),
            ),
          ),
        ),
        h(
          'td',
          typeSelect(o.type, (t) => this.update(s, (f) => (f.outputs[i]!.type = t))),
        ),
        h(
          'td',
          num(
            o.scale,
            (n) => this.update(s, (f) => (f.outputs[i]!.scale = n)),
            `output-scale-${i}`,
          ),
        ),
        h(
          'td',
          num(o.weight, (n) => this.update(s, (f) => (f.outputs[i]!.weight = n))),
        ),
        h(
          'td',
          check(o.reflect, (b) => this.update(s, (f) => (f.outputs[i]!.reflect = b))),
        ),
        h('td', peakEl),
        h(
          'td',
          h(
            'button.step',
            {
              title: 'Scale so the peak above reaches 100 %',
              dataset: { testid: `rescale-above-${i}` },
              on: { click: () => this.rescale(s, i, 'above') },
            },
            '100 % ↑',
          ),
          h(
            'button.step',
            {
              title: 'Scale so the peak below reaches 100 %',
              on: { click: () => this.rescale(s, i, 'below') },
            },
            '100 % ↓',
          ),
          remove('outputs', i),
        ),
      );
    });
    const range = (what: 'position' | 'angle') => {
      const r = s.normalization[what];
      return h(
        'label.field',
        h('span', what === 'position' ? 'Position range' : 'Angle range'),
        h(
          'span.field-input',
          num(r.min, (n) => this.update(s, (f) => (f.normalization[what].min = n))),
          num(r.default, (n) => this.update(s, (f) => (f.normalization[what].default = n))),
          num(r.max, (n) => this.update(s, (f) => (f.normalization[what].max = n))),
        ),
      );
    };
    return h(
      'div.physics-edit',
      h('label.field', h('span', 'Name'), name),
      problems.length
        ? h(
            'div.physics-problems',
            problems.map((l) =>
              h('div.refusal', { dataset: { testid: 'physics-problem' } }, l.message),
            ),
          )
        : null,
      h('h3', 'Inputs'),
      h(
        'table.physics-table',
        h(
          'tr',
          ['Parameter', 'As', 'Share (%)', 'Invert', ''].map((t) => h('th', t)),
        ),
        s.inputs.map((x, i) =>
          h(
            'tr',
            h(
              'td',
              paramSelect(
                x.parameter,
                (u) => this.update(s, (f) => (f.inputs[i]!.parameter = u)),
                `input-param-${i}`,
              ),
            ),
            h(
              'td',
              typeSelect(x.type, (t) => this.update(s, (f) => (f.inputs[i]!.type = t))),
            ),
            h(
              'td',
              num(
                x.weight,
                (n) => this.update(s, (f) => (f.inputs[i]!.weight = n)),
                `input-weight-${i}`,
              ),
            ),
            h(
              'td',
              check(x.reflect, (b) => this.update(s, (f) => (f.inputs[i]!.reflect = b))),
            ),
            h('td', remove('inputs', i)),
          ),
        ),
      ),
      h(
        'button',
        {
          disabled: !firstParam,
          dataset: { testid: 'input-add' },
          on: {
            click: () =>
              this.update(
                s,
                (f) =>
                  f.inputs.push({ parameter: firstParam!, type: 'X', weight: 100, reflect: false }),
                'Add physics input',
              ),
          },
        },
        '+ Input',
      ),
      range('position'),
      range('angle'),
      h('h3', 'Pendulum'),
      h(
        'table.physics-table',
        h(
          'tr',
          ['', 'X', 'Y', 'Length', 'Swing', 'Reaction', 'Settling', ''].map((t) => h('th', t)),
        ),
        s.particles.map((p, i) =>
          h(
            'tr',
            h('td', i === 0 ? 'root' : `stage ${i}`),
            h(
              'td',
              num(p.x, (n) => this.update(s, (f) => (f.particles[i]!.x = n))),
            ),
            h(
              'td',
              num(p.y, (n) => this.update(s, (f) => (f.particles[i]!.y = n))),
            ),
            h(
              'td',
              num(p.radius, (n) => this.update(s, (f) => (f.particles[i]!.radius = n))),
            ),
            h(
              'td',
              num(
                p.mobility,
                (n) => this.update(s, (f) => (f.particles[i]!.mobility = n)),
                `particle-mobility-${i}`,
                '0.01',
              ),
            ),
            h(
              'td',
              num(
                p.delay,
                (n) => this.update(s, (f) => (f.particles[i]!.delay = n)),
                undefined,
                '0.01',
              ),
            ),
            h(
              'td',
              num(
                p.acceleration,
                (n) => this.update(s, (f) => (f.particles[i]!.acceleration = n)),
                undefined,
                '0.01',
              ),
            ),
            h('td', remove('particles', i)),
          ),
        ),
      ),
      h(
        'div.buttons',
        h(
          'button',
          {
            dataset: { testid: 'particle-add' },
            on: {
              click: () =>
                this.update(
                  s,
                  (f) => {
                    const last = f.particles.at(-1)!;
                    f.particles.push({
                      ...last,
                      y: last.y + (last.radius || 6),
                      radius: last.radius || 6,
                    });
                  },
                  'Add pendulum stage',
                ),
            },
          },
          '+ Stage',
        ),
        h(
          'select',
          {
            title: 'Replace the pendulum with a preset',
            on: {
              change: (e) => {
                const k = (e.target as HTMLSelectElement).value;
                if (!PENDULUM_PRESETS[k]) return;
                this.update(
                  s,
                  (f) => {
                    f.particles = structuredClone(PENDULUM_PRESETS[k]!);
                    for (const o of f.outputs)
                      o.particle = Math.min(o.particle, f.particles.length - 1);
                  },
                  'Pendulum preset',
                );
              },
            },
          },
          h('option', { value: '' }, 'Preset…'),
          Object.keys(PENDULUM_PRESETS).map((k) => h('option', k)),
        ),
      ),
      h(
        'div.hint',
        'Swing: how readily it swings (0.7 to 0.99 suits most); Reaction: how fast it follows; Settling: how fast it comes to rest; Length: the distance from the stage before.',
      ),
      h('h3', 'Outputs'),
      h(
        'table.physics-table',
        h(
          'tr',
          ['Parameter', 'Stage', 'As', 'Scale', 'Share (%)', 'Invert', 'Peak', ''].map((t) =>
            h('th', t),
          ),
        ),
        outputRows,
      ),
      h(
        'button',
        {
          disabled: !firstParam,
          dataset: { testid: 'output-add' },
          on: {
            click: () =>
              this.update(
                s,
                (f) =>
                  f.outputs.push({
                    parameter: firstParam!,
                    type: 'Angle',
                    weight: 100,
                    reflect: false,
                    particle: f.particles.length - 1,
                    scale: 1,
                  }),
                'Add physics output',
              ),
          },
        },
        '+ Output',
      ),
      h(
        'div.hint',
        'An output that peaks over 100 % of its range makes the motion choppy: use 100 % ↑ or ↓ after a test to scale it back.',
      ),
    );
  }
}
