/**
 * «Motion Sync» (Modeling › Motion Sync…), Mochi Maker's own design. A modeless dialog over the project's motion-sync settings:
 *
 * - the settings: add, remove, rename, and their sample rate, smoothing, blend ratio and use case;
 * - the driven parameters, with their dead band (damper) and smoothing;
 * - the audio elements (Silence and the vowels by default): enabled and scale;
 * - the shapes, a grid of elements × driven parameters. «From pose» fills a row from the editor's
 *   pose (set the mouth with the sliders, then take it); «Pose» shows a row on the model. New
 *   settings start the usual mouth parameters at typical vowel shapes, a starting point;
 * - the preview: a WAV file played through Mochi2D's own analysis on the shown model, with a meter
 *   of the elements' weights.
 *
 * Every change is one command (`motionSync.addSetting`, `updateSetting`, `removeSetting`), so it
 * undoes in one step and agents can do the same.
 */
import type { MotionSyncSetting, Uid } from '@mochi-maker/core';
import { dialog, type Dialog } from './dialogs.js';
import { fill, h } from './dom.js';
import type { Editor } from './editor.js';
import type { Viewport } from './viewport.js';
import { fileBytes } from './limits.js';

export function motionSyncDialog(editor: Editor, viewport: Viewport): Dialog {
  const body = h('div.motion-sync');
  let current: Uid | null = editor.view.project().motionSyncOrder[0] ?? null;
  let stopTicks: (() => void) | null = null;
  const meter = h('div.ms-meter', { dataset: { testid: 'ms-meter' } });
  const status = h('div.facts', { dataset: { testid: 'ms-status' } });
  const run = (label: string, name: string, args: Record<string, unknown>) =>
    editor.transact(label, [{ name, args }]);
  const update = (s: MotionSyncSetting, fields: Record<string, unknown>, label = 'Motion sync') =>
    run(label, 'motionSync.updateSetting', { target: s.uid, ...fields });
  const num = (
    value: number,
    testid: string,
    set: (n: number) => void,
    step = '0.01',
    title = '',
  ) =>
    h('input.num', {
      type: 'number',
      step,
      value: String(value),
      title,
      dataset: { testid },
      on: {
        change: (e) => {
          const n = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(n)) set(n);
        },
      },
    });

  const stopPreview = () => {
    stopTicks?.();
    stopTicks = null;
    viewport.model?.runtime.stopMotionSync();
  };
  const preview = async (s: MotionSyncSetting, file: File) => {
    stopPreview();
    const model = viewport.model;
    if (!model) return;
    const rt = model.runtime;
    if (!rt.motionSyncSettings.some((x) => x.name === s.name)) {
      status.textContent = 'The view is still building; try again in a moment.';
      return;
    }
    try {
      rt.startMotionSync(await fileBytes(file), { setting: s.name });
    } catch (e) {
      status.textContent = (e as Error).message;
      return;
    }
    status.textContent = `Playing ${file.name} through «${s.name}».`;
    stopTicks = rt.onMotionSyncTick((t) => {
      fill(
        meter,
        s.elements.map((el) =>
          h(
            'div.ms-bar',
            { title: el.id },
            h('span', el.id),
            h('i', {
              style: `width:${Math.round(((t.weights as Record<string, number>)[el.id] ?? 0) * 100)}%`,
            }),
          ),
        ),
        h('div.dim', `${t.level.toFixed(1)} dBFS`),
      );
    });
  };

  const render = () => {
    const v = editor.view;
    const settings = v.project().motionSyncOrder.map((u) => v.getAs(u, 'motionSyncSetting'));
    if (current && !settings.some((s) => s.uid === current)) current = settings[0]?.uid ?? null;
    const s = settings.find((x) => x.uid === current) ?? null;
    const params = v.ofKind('parameter').filter((p) => p.type === 'normal');
    const list = h(
      'div.rows.ms-settings',
      settings.map((x) =>
        h(
          'div.row',
          {
            class: x.uid === current ? 'selected' : '',
            dataset: { setting: x.name },
            on: { click: () => ((current = x.uid), render()) },
          },
          h('span.name', x.name),
          h('span.extra', `${x.parameters.length} parameter(s)`),
        ),
      ),
    );
    const head = h(
      'div.buttons',
      h(
        'button',
        {
          dataset: { testid: 'ms-add' },
          on: {
            click: () => {
              const names = new Set(settings.map((x) => x.name));
              let name = 'Mouth';
              for (let i = 2; names.has(name); i++) name = `Mouth ${i}`;
              const mouth = params.filter((p) => /mouth/i.test(p.exportId)).map((p) => p.uid);
              const r = run('Add motion-sync setting', 'motionSync.addSetting', {
                name,
                parameters: mouth.map((p) => ({ parameter: p })),
              });
              const uid = (r?.results[0] as { uid?: Uid } | undefined)?.uid;
              if (uid) current = uid;
            },
          },
        },
        'Add setting',
      ),
      h(
        'button',
        {
          disabled: !s,
          dataset: { testid: 'ms-remove' },
          on: {
            click: () =>
              s && run('Remove motion-sync setting', 'motionSync.removeSetting', { target: s.uid }),
          },
        },
        'Remove',
      ),
    );
    if (!s) {
      fill(body, head, list, h('div.empty', 'No motion-sync settings yet.'));
      return;
    }
    const field = (label: string, input: Node) => h('label.field', h('span', label), input);
    const nameInput = h('input', {
      type: 'text',
      value: s.name,
      dataset: { testid: 'ms-name' },
      on: { change: (e) => update(s, { name: (e.target as HTMLInputElement).value }) },
    });
    const pIds = s.parameters.map((p) => v.getAs(p.parameter, 'parameter').exportId);
    const driven = h(
      'div.rows',
      s.parameters.map((p, k) =>
        h(
          'div.row',
          h('span.name', pIds[k]!),
          h('span.extra', 'damper'),
          num(p.damper, `ms-damper-${pIds[k]}`, (n) =>
            update(s, {
              parameters: s.parameters.map((q, j) => ({
                ...q,
                damper: j === k ? Math.max(0, n) : q.damper,
              })),
            }),
          ),
          h('span.extra', 'smooth %'),
          num(
            p.smooth,
            `ms-smooth-${pIds[k]}`,
            (n) =>
              update(s, {
                parameters: s.parameters.map((q, j) => ({
                  ...q,
                  smooth: j === k ? Math.min(100, Math.max(0, n)) : q.smooth,
                })),
              }),
            '1',
          ),
          h(
            'button',
            {
              title: 'Stop driving this parameter',
              on: {
                click: () =>
                  update(
                    s,
                    { parameters: s.parameters.filter((_, j) => j !== k) },
                    'Motion sync: remove parameter',
                  ),
              },
            },
            '×',
          ),
        ),
      ),
    );
    const addParam = h(
      'select',
      {
        dataset: { testid: 'ms-add-param' },
        on: {
          change: (e) => {
            const uid = (e.target as HTMLSelectElement).value;
            if (uid)
              update(
                s,
                { parameters: [...s.parameters, { parameter: uid }] },
                'Motion sync: add parameter',
              );
          },
        },
      },
      h('option', { value: '' }, 'Drive another parameter…'),
      params
        .filter((p) => !s.parameters.some((q) => q.parameter === p.uid))
        .map((p) => h('option', { value: p.uid }, p.exportId)),
    );
    const grid = h(
      'table.ms-shapes',
      { dataset: { testid: 'ms-shapes' } },
      h(
        'tr',
        h('th', 'Element'),
        h('th', 'On'),
        h('th', 'Scale'),
        pIds.map((id) => h('th', id)),
        h('th', ''),
      ),
      s.elements.map((el, e) =>
        h(
          'tr',
          { dataset: { element: el.id } },
          h('td', el.id),
          h(
            'td',
            h('input', {
              type: 'checkbox',
              checked: el.enabled,
              on: {
                change: (ev) =>
                  update(s, {
                    elements: s.elements.map((x, j) =>
                      j === e ? { ...x, enabled: (ev.target as HTMLInputElement).checked } : x,
                    ),
                  }),
              },
            }),
          ),
          h(
            'td',
            num(el.scale, `ms-scale-${el.id}`, (n) =>
              update(s, {
                elements: s.elements.map((x, j) =>
                  j === e ? { ...x, scale: Math.min(10, Math.max(0.1, n)) } : x,
                ),
              }),
            ),
          ),
          s.parameters.map((_, k) =>
            h(
              'td',
              num(s.shapes[e]![k]!, `ms-shape-${el.id}-${pIds[k]}`, (n) =>
                update(s, {
                  shapes: s.shapes.map((row, i) => row.map((x, j) => (i === e && j === k ? n : x))),
                }),
              ),
            ),
          ),
          h(
            'td',
            h(
              'button',
              {
                dataset: { testid: `ms-from-pose-${el.id}` },
                title: "Take this element's shape from the editor's pose",
                on: {
                  click: () =>
                    update(
                      s,
                      {
                        shapes: s.shapes.map((row, i) =>
                          i === e ? s.parameters.map((p) => editor.value(p.parameter)) : row,
                        ),
                      },
                      `Motion sync: ${el.id} from the pose`,
                    ),
                },
              },
              'From pose',
            ),
            h(
              'button',
              {
                title: "Show this element's shape on the model",
                on: {
                  click: () => {
                    for (const [k, p] of s.parameters.entries())
                      editor.setPoseRaw(p.parameter, s.shapes[e]![k]!);
                    editor.emit('pose', undefined);
                  },
                },
              },
              'Pose',
            ),
          ),
        ),
      ),
    );
    const wav = h('input', {
      type: 'file',
      accept: '.wav,audio/wav',
      dataset: { testid: 'ms-wav' },
      on: {
        change: (e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          if (f) void preview(s, f);
        },
      },
    }) as HTMLInputElement;
    fill(
      body,
      head,
      list,
      h('h3', 'Setting'),
      field('Name', nameInput),
      field(
        'Use case',
        h('input', {
          type: 'text',
          value: s.useCase,
          on: { change: (e) => update(s, { useCase: (e.target as HTMLInputElement).value }) },
        }),
      ),
      field(
        'Sample rate (ticks/s)',
        num(
          s.sampleRate,
          'ms-rate',
          (n) => update(s, { sampleRate: Math.min(120, Math.max(1, n)) }),
          '1',
        ),
      ),
      field(
        'Smoothing (1–100)',
        num(
          s.smoothing,
          'ms-smoothing',
          (n) => update(s, { smoothing: Math.min(100, Math.max(1, n)) }),
          '1',
        ),
      ),
      field(
        'Blend ratio (0–1)',
        num(
          s.blendRatio,
          'ms-blend',
          (n) => update(s, { blendRatio: Math.min(1, Math.max(0, n)) }),
          '0.05',
          "0: the likeliest element's shape; 1: the shapes blended by weight",
        ),
      ),
      h('h3', 'Driven parameters'),
      driven,
      addParam,
      h('h3', 'Elements and their shapes'),
      h(
        'p.hint',
        { dataset: { testid: 'ms-shapes-hint' } },
        'A new setting starts ParamMouthOpenY and ParamMouthForm at typical vowel shapes, and other ' +
          'parameters at 0. They are a starting point: set the mouth for each element with the ' +
          'sliders and take it with «From pose», or type the values.',
      ),
      grid,
      h('h3', 'Preview'),
      h(
        'p.dim',
        { dataset: { testid: 'ms-preview-note' } },
        'The preview applies each parameter’s smooth %, so it shows what these values do. ' +
          'Apps differ here: Mochi2D leaves that smoothing off unless an app turns it on, and ' +
          'then only the setting’s Smoothing and each damper shape the motion.',
      ),
      h(
        'div.buttons',
        h('label.button', 'Play a WAV file…', wav),
        h(
          'button',
          {
            dataset: { testid: 'ms-stop' },
            on: { click: () => (stopPreview(), (status.textContent = 'Stopped.')) },
          },
          'Stop',
        ),
      ),
      meter,
      status,
    );
  };
  const off = editor.on('document', () => render());
  const d = dialog('Motion Sync', [body], {
    testid: 'motion-sync',
    modal: false,
    wide: true,
    onClose: () => {
      stopPreview();
      off?.();
    },
  });
  render();
  return d;
}
