/**
 * Agent access (agent API design 5 and 6): connecting the editor to the bridge, pairing, client
 * tokens with scopes, the connected agents, and the band over the viewport that shows them while
 * they are connected, with Pause and Disconnect.
 */
import { round, type Editor } from './editor.js';
import { fill, h } from './dom.js';
import { DEFAULT_BRIDGE, type BridgeHost } from './host.js';

export class AgentAccess {
  readonly el = h('div.commandbar.access', { hidden: true, dataset: { testid: 'agent-access' } });
  readonly band = h('div.band', { hidden: true, dataset: { testid: 'agent-band' } });
  private readonly body = h('div.access-body');
  private lastToken: { token: string; name: string } | null = null;
  private error = '';
  private readonly form: { name: string; scope: 'read' | 'edit' | 'export' } = {
    name: 'agent',
    scope: 'edit',
  };

  constructor(
    private readonly editor: Editor,
    private readonly host: BridgeHost,
  ) {
    this.el.append(h('div.cmd-box', { on: { click: (e) => e.stopPropagation() } }, this.body));
    this.el.addEventListener('click', () => this.close());
    this.el.addEventListener('keydown', (e) => e.key === 'Escape' && this.close());
    for (const ev of ['state', 'clients', 'tokens'] as const) host.on(ev, () => this.refresh());
    host.on('call', () => this.renderBand());
    host.on('error', (m) => {
      this.error = m;
      this.editor.emit('message', { level: 'error', text: m });
      this.refresh();
    });
    editor.on('control', () => this.renderBand());
    this.refresh();
  }

  open(): void {
    this.el.hidden = false;
    this.render();
  }

  close(): void {
    this.el.hidden = true;
    this.lastToken = null; // a token is shown once
  }

  private refresh(): void {
    if (!this.el.hidden) this.render();
    this.renderBand();
  }

  private render(): void {
    const host = this.host;
    const url = h('input.url', {
      value: host.url || DEFAULT_BRIDGE,
      dataset: { testid: 'bridge-url' },
    });
    const state = {
      off: 'Not connected. Agents cannot reach this editor.',
      connecting: 'Connecting…',
      pairing: 'Enter the pairing code that "mochi-maker bridge" shows.',
      connected: `Connected to the bridge at ${host.url}.`,
    }[host.state];
    const section = (title: string, ...children: (Node | null)[]) =>
      h('div.section', h('h3', title), ...children);

    const connectRow =
      host.state === 'off'
        ? h(
            'div.buttons',
            url,
            h(
              'button.primary',
              {
                dataset: { testid: 'bridge-connect' },
                on: {
                  click: () => {
                    this.error = '';
                    void host.connect(url.value);
                  },
                },
              },
              'Connect',
            ),
          )
        : h(
            'div.buttons',
            h(
              'button',
              { dataset: { testid: 'bridge-disconnect' }, on: { click: () => host.disconnect() } },
              'Disconnect',
            ),
          );
    const code = h('input.code', {
      placeholder: '123456',
      inputmode: 'numeric',
      maxlength: 6,
      dataset: { testid: 'pairing-code' },
    });
    const pairRow =
      host.state === 'pairing'
        ? h(
            'div.buttons',
            code,
            h(
              'button.primary',
              { dataset: { testid: 'pair' }, on: { click: () => host.pair(code.value) } },
              'Pair',
            ),
          )
        : null;

    let tokens: Node | null = null;
    if (host.state === 'connected') {
      // The form keeps its values when the dialog re-renders (a client connects, a token is used).
      const name = h('input', {
        placeholder: 'Agent name',
        value: this.form.name,
        dataset: { testid: 'token-name' },
        on: { input: (e) => (this.form.name = (e.target as HTMLInputElement).value) },
      });
      const scope = h(
        'select',
        {
          dataset: { testid: 'token-scope' },
          on: {
            change: (e) =>
              (this.form.scope = (e.target as HTMLSelectElement).value as
                'read' | 'edit' | 'export'),
          },
        },
        h(
          'option',
          { value: 'read', selected: this.form.scope === 'read' },
          'Read: look, query, render',
        ),
        h(
          'option',
          { value: 'edit', selected: this.form.scope === 'edit' },
          'Edit: also change the document',
        ),
        h(
          'option',
          { value: 'export', selected: this.form.scope === 'export' },
          'Export: also export files',
        ),
      );
      const create = async () => {
        const r = await host.createToken(name.value, scope.value as 'read' | 'edit' | 'export');
        this.lastToken = { token: r.token, name: r.info.name };
        this.render();
      };
      tokens = section(
        'Tokens',
        h(
          'div.hint',
          'Give an agent a token; it connects with it (mochi-maker mcp --bridge --token …). Revoking disconnects it.',
        ),
        h(
          'div.buttons',
          name,
          scope,
          h(
            'button',
            { dataset: { testid: 'token-create' }, on: { click: () => void create() } },
            'Create token',
          ),
        ),
        this.lastToken
          ? h(
              'div.token',
              h('span', `Token for ${this.lastToken.name} (shown once):`),
              h('input', {
                readonly: true,
                value: this.lastToken.token,
                dataset: { testid: 'token-value' },
                on: { focus: (e) => (e.target as HTMLInputElement).select() },
              }),
            )
          : null,
        h(
          'div.rows',
          host.tokens.map((t) =>
            h(
              'div.row',
              { dataset: { token: t.id } },
              h('span.name', t.name),
              h('span.author', t.scopes.join(', ')),
              h(
                'span.rev',
                t.lastUsed ? `used ${new Date(t.lastUsed).toLocaleTimeString()}` : 'never used',
              ),
              h(
                'button',
                {
                  dataset: { testid: `revoke-${t.name}` },
                  on: { click: () => void host.revokeToken(t.id) },
                },
                'Revoke',
              ),
            ),
          ),
          host.tokens.length ? null : h('div.empty', 'No tokens yet.'),
        ),
      );
    }

    const clients = section(
      'Connected agents',
      h(
        'div.rows',
        host.clients.map((c) =>
          h(
            'div.row',
            { dataset: { client: c.name } },
            h('span.name', c.name),
            h('span.author', c.scopes.join(', ')),
            h('span.rev', `since ${new Date(c.connectedAt).toLocaleTimeString()}`),
          ),
        ),
        host.clients.length ? null : h('div.empty', 'None.'),
      ),
    );

    fill(
      this.body,
      h('h2', 'Agent access'),
      h('div.facts', { dataset: { testid: 'bridge-state' } }, state),
      this.error ? h('div.refusal', this.error) : null,
      section(
        'Bridge',
        connectRow,
        pairRow,
        h(
          'div.hint',
          'Agents connect through "mochi-maker bridge" on this machine only (127.0.0.1). Nothing is reachable until you connect here.',
        ),
      ),
      tokens,
      clients,
      h('div.buttons', h('button', { on: { click: () => this.close() } }, 'Close')),
    );
  }

  /** The band over the viewport: who is connected, what they run, and the person's controls. */
  renderBand(): void {
    const clients = this.host.clients;
    this.band.hidden = clients.length === 0;
    if (clients.length === 0) return;
    const c = this.editor.control;
    const doing = this.host.current
      ? `${this.host.current.client} is running "${this.host.current.label}"`
      : 'idle';
    const lease =
      c.holder === 'paused'
        ? 'Agents are paused.'
        : c.holder === 'person'
          ? `You are editing; agents wait (${round(c.retryAfter / 1000, 1)} s).`
          : 'Agents may edit.';
    fill(
      this.band,
      h('b', clients.map((x) => `${x.name} (${x.scopes.join(', ')})`).join(', ')),
      h('span', { dataset: { testid: 'band-doing' } }, doing),
      h('span', { dataset: { testid: 'band-lease' } }, lease),
      h(
        'button',
        {
          dataset: { testid: 'pause-agents' },
          on: { click: () => this.editor.setPaused(c.holder !== 'paused') },
        },
        c.holder === 'paused' ? 'Resume agents' : 'Pause agents',
      ),
      h('button', { on: { click: () => this.host.disconnect() } }, 'Disconnect'),
    );
  }
}
