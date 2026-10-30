// Dialogs for AI settings, "Suggest layout" and "Fill from description".
import { planExtent } from '../editor/blocks';
import type { Store } from '../editor/store';
import { applyChanges, describePrompt, DESCRIBE_SYSTEM, describeSchema, parseDescribeReply, planChanges, type Change } from './describe';
import { applySuggestion, layoutPrompt, LAYOUT_SYSTEM, layoutSchema, parseLayoutReply, planForAi } from './layout';
import { AiError, callAi, PROVIDERS, testConnection, type ProviderId } from './providers';
import { forgetKeys, loadSettings, saveSettings } from './settings';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function dialog(id: string, title: string): HTMLDialogElement {
  const d = document.createElement('dialog');
  d.id = id;
  d.className = 'ai-dialog';
  d.setAttribute('aria-labelledby', `${id}-title`);
  d.innerHTML = `<form method="dialog" class="ai-form"><h2 id="${id}-title">${title}</h2><div class="ai-body"></div></form>`;
  document.body.appendChild(d);
  return d;
}

const errorText = (e: unknown) =>
  e instanceof AiError || e instanceof Error ? e.message : 'Something went wrong. Try again.';

export function setupAi(opts: { store: Store; message: (t: string, kind?: 'info' | 'error') => void; afterChange: () => void }) {
  const { store, message } = opts;

  // ---- settings ----
  const settingsDlg = dialog('ai-settings-dialog', 'AI settings');
  let afterSettings: (() => void) | null = null;

  function openSettings(then?: () => void) {
    afterSettings = then ?? null;
    renderSettings(loadSettings().provider);
    settingsDlg.showModal();
  }

  function renderSettings(provider: ProviderId) {
    const s = loadSettings(provider);
    const info = PROVIDERS[provider];
    settingsDlg.querySelector('.ai-body')!.innerHTML = `
      <p class="note">Uses your own API key. It stays in this browser and requests go straight from here to the provider.
        The plan image and your notes are sent to the provider you choose.</p>
      <label class="field"><span>Provider</span>
        <select name="provider">${Object.values(PROVIDERS).map((p) => `<option value="${p.id}" ${p.id === provider ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      </label>
      <label class="field"><span>API key</span>
        <input name="key" type="password" autocomplete="off" spellcheck="false" value="${esc(s.apiKey)}" placeholder="Paste your key">
        <small>${esc(info.keyHint)}${info.keyUrl ? ` <a href="${info.keyUrl}" target="_blank" rel="noopener">Get a key</a>` : ''}</small>
      </label>
      <label class="field"><span>Model</span>
        <input name="model" type="text" spellcheck="false" value="${esc(s.model)}" placeholder="e.g. gpt-5-mini, gemini-3-flash, llava">
      </label>
      <details ${provider === 'openai-compatible' ? 'open' : ''}><summary>Base URL</summary>
        <label class="field"><span>Base URL</span><input name="baseUrl" type="url" spellcheck="false" value="${esc(s.baseUrl)}"></label>
        <small class="note">Local models: Ollama at http://localhost:11434/v1 (start it with OLLAMA_ORIGINS set to this site).</small>
      </details>
      <label class="check"><input type="checkbox" name="remember" ${s.remember ? 'checked' : ''}> Remember the key on this device</label>
      <p class="ai-status" role="status"></p>
      <div class="actions">
        <button type="button" data-act="test">Test connection</button>
        <button type="button" data-act="forget" class="danger">Forget saved keys</button>
        <span class="grow"></span>
        <button value="cancel" formnovalidate>Cancel</button>
        <button type="button" class="primary" data-act="save">Save</button>
      </div>`;
  }

  const readSettingsForm = () => {
    const f = (n: string) => settingsDlg.querySelector<HTMLInputElement>(`[name="${n}"]`)!;
    return {
      provider: f('provider').value as ProviderId,
      apiKey: f('key').value.trim(),
      model: f('model').value.trim(),
      baseUrl: f('baseUrl').value.trim(),
      remember: f('remember').checked,
    };
  };

  settingsDlg.addEventListener('change', (e) => {
    if ((e.target as HTMLElement).getAttribute('name') === 'provider') renderSettings(readSettingsForm().provider);
  });
  settingsDlg.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    const status = settingsDlg.querySelector<HTMLElement>('.ai-status')!;
    if (act === 'test') {
      status.textContent = 'Testing…';
      status.className = 'ai-status';
      try {
        status.textContent = await testConnection(readSettingsForm());
      } catch (err) {
        status.textContent = errorText(err);
        status.className = 'ai-status bad';
      }
    } else if (act === 'forget') {
      forgetKeys();
      settingsDlg.querySelector<HTMLInputElement>('[name="key"]')!.value = '';
      status.textContent = 'Saved keys removed from this device.';
    } else if (act === 'save') {
      saveSettings(readSettingsForm());
      settingsDlg.close();
      const next = afterSettings;
      afterSettings = null;
      next?.();
    }
  });

  /** Opens settings first when no key is set, then continues. */
  function withKey(run: () => void) {
    if (loadSettings().apiKey) run();
    else openSettings(run);
  }

  // ---- suggest layout ----
  const layoutDlg = dialog('ai-layout-dialog', 'Suggest layout with AI');
  let controller: AbortController | null = null;

  /** `afterUpload`: the plan was just uploaded, so ask whether to place blocks at all. */
  function openLayout(afterUpload = false) {
    const bg = store.model.background;
    if (!bg?.file.startsWith('data:')) {
      message('Upload a floor plan first; the AI reads the plan image.', 'error');
      return;
    }
    const s = loadSettings();
    const hasBlocks = store.model.blocks.length > 0;
    layoutDlg.querySelector('h2')!.textContent = afterUpload ? 'Let AI place the blocks?' : 'Suggest layout with AI';
    layoutDlg.querySelector('.ai-body')!.innerHTML = `
      <p class="note">${afterUpload ? 'Plan loaded. ' : ''}The AI looks at your plan, finds entrances, lines, counters, seating and exits,
        and places the blocks and links for you. Numbers it cannot read from the plan (arrival rates, service times)
        are left as placeholders and flagged for you to fill in.</p>
      <label class="field"><span>How does this space work? (optional)</span>
        <textarea name="context" rows="3" placeholder="e.g. Bank branch: customers take a ticket, wait, then go to one of the teller windows."></textarea>
      </label>
      ${hasBlocks ? `<fieldset class="field"><legend>Your current ${store.model.blocks.length} blocks</legend>
        <label class="check"><input type="radio" name="mode" value="replace" checked> Replace them</label>
        <label class="check"><input type="radio" name="mode" value="add"> Keep them and add the suggestion</label>
      </fieldset>` : ''}
      <p class="note">Sends the plan image to <strong>${esc(PROVIDERS[s.provider].name)}</strong> (${esc(s.model)}).
        ${s.apiKey ? '' : 'You will be asked for your API key first. '}
        <button type="button" class="link-btn" data-act="settings">Change</button></p>
      <p class="ai-status" role="status"></p>
      <div class="actions">
        <span class="grow"></span>
        <button value="cancel" formnovalidate data-act="cancel">${afterUpload ? 'No, I’ll place them' : 'Cancel'}</button>
        <button type="button" class="primary" data-act="run">${afterUpload ? 'Yes, place blocks' : 'Suggest layout'}</button>
      </div>`;
    layoutDlg.showModal();
  }

  layoutDlg.addEventListener('close', () => controller?.abort());
  layoutDlg.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'settings') {
      layoutDlg.close();
      openSettings(() => withKey(() => openLayout()));
      return;
    }
    if (act === 'undo') {
      store.undo();
      layoutDlg.close();
      message('Suggestion undone.');
      return;
    }
    if (act !== 'run') return;
    if (!loadSettings().apiKey) {
      // Ask for the key, then come straight back and run with what was already typed here.
      layoutDlg.close();
      openSettings(() => {
        layoutDlg.showModal();
        void runLayout();
      });
      return;
    }
    await runLayout();
  });

  async function runLayout() {
    const status = layoutDlg.querySelector<HTMLElement>('.ai-status')!;
    const runBtn = layoutDlg.querySelector<HTMLButtonElement>('[data-act="run"]')!;
    const context = layoutDlg.querySelector<HTMLTextAreaElement>('[name="context"]')!.value;
    const mode = (layoutDlg.querySelector<HTMLInputElement>('[name="mode"]:checked')?.value ?? 'replace') as 'replace' | 'add';
    runBtn.disabled = true;
    status.className = 'ai-status';
    status.textContent = 'Reading the plan… this can take up to a minute.';
    controller = new AbortController();
    try {
      const image = await planForAi(store.model.background!.file);
      const text = await callAi(loadSettings(), {
        system: LAYOUT_SYSTEM, text: layoutPrompt(context), imageDataUrl: image,
        schemaName: 'floor_plan_model', schema: layoutSchema as unknown as Record<string, unknown>, signal: controller.signal,
      });
      const reply = parseLayoutReply(text);
      if (!reply.blocks.length) throw new AiError(`The AI found no blocks on this plan.${reply.notes ? ` It said: ${reply.notes}` : ''}`);
      const applied = applySuggestion(store.model, reply, planExtent(store.model), mode);
      store.commit((m) => {
        m.blocks = applied.model.blocks;
        m.links = applied.model.links;
      });
      store.select(null);
      opts.afterChange();
      layoutDlg.querySelector('.ai-body')!.innerHTML = `
        <p><strong>Added ${applied.addedBlocks} blocks and ${applied.addedLinks} links</strong>, marked “AI” on the plan.</p>
        ${applied.needsInput ? `<p class="issue warning">${applied.needsInput} block${applied.needsInput > 1 ? 's need' : ' needs'} numbers the plan does not show.
          They are listed in Checks; fill them in, or use <em>AI fill</em> to describe them in words.</p>` : ''}
        ${applied.notes ? `<p class="note"><strong>AI notes:</strong> ${esc(applied.notes)}</p>` : ''}
        ${applied.dropped.length ? `<details><summary>${applied.dropped.length} link${applied.dropped.length > 1 ? 's' : ''} left out</summary>
          <ul>${applied.dropped.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></details>` : ''}
        <p class="note">Review each block: move, edit or delete it, and add or remove flows with the Link tool.</p>
        <div class="actions"><span class="grow"></span>
          <button type="button" data-act="undo">Undo suggestion</button>
          <button value="done" class="primary">Review on the plan</button>
        </div>`;
      message(`AI suggested ${applied.addedBlocks} blocks. Review them on the plan.`);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      status.className = 'ai-status bad';
      status.textContent = errorText(err);
      runBtn.disabled = false;
    } finally {
      controller = null;
    }
  }

  // ---- fill from description ----
  const fillDlg = dialog('ai-fill-dialog', 'Fill numbers from a description');
  let pending: Change[] = [];

  function openFill() {
    if (!store.model.blocks.length) {
      message('Add or suggest blocks first; the description fills in their numbers.', 'error');
      return;
    }
    const s = loadSettings();
    fillDlg.querySelector('.ai-body')!.innerHTML = `
      <label class="field"><span>Describe the numbers in your own words</span>
        <textarea name="text" rows="4" placeholder="e.g. About 30 customers an hour. 3 tellers, each takes about 4 minutes. 1 in 5 goes to the loan desk."></textarea>
      </label>
      <p class="note">Uses ${esc(PROVIDERS[s.provider].name)} (${esc(s.model)}). Only your words and the block names are sent.</p>
      <p class="ai-status" role="status"></p>
      <div class="ai-changes"></div>
      <div class="actions">
        <span class="grow"></span>
        <button value="cancel" formnovalidate>Cancel</button>
        <button type="button" data-act="read">Read description</button>
        <button type="button" class="primary" data-act="apply" hidden>Apply selected</button>
      </div>`;
    fillDlg.showModal();
  }

  fillDlg.addEventListener('close', () => controller?.abort());
  fillDlg.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    const status = fillDlg.querySelector<HTMLElement>('.ai-status')!;
    if (act === 'read') {
      const text = fillDlg.querySelector<HTMLTextAreaElement>('[name="text"]')!.value;
      if (!text.trim()) {
        status.textContent = 'Write a description first.';
        return;
      }
      status.className = 'ai-status';
      status.textContent = 'Reading…';
      controller = new AbortController();
      try {
        const reply = parseDescribeReply(await callAi(loadSettings(), {
          system: DESCRIBE_SYSTEM, text: describePrompt(store.model, text),
          schemaName: 'parameter_updates', schema: describeSchema as unknown as Record<string, unknown>, signal: controller.signal,
        }));
        pending = planChanges(store.model, reply);
        status.textContent = pending.length ? 'Tick the changes to apply.' : 'No numbers found that match your blocks.';
        fillDlg.querySelector('.ai-changes')!.innerHTML = pending.map((c, i) => `
          <label class="check change ${c.problem ? 'bad' : ''}">
            <input type="checkbox" data-i="${i}" ${c.problem ? 'disabled' : 'checked'}>
            <span><strong>${esc(c.summary)}</strong>
              <small>${c.problem ? esc(c.problem) : `from “${esc(c.evidence)}”`}</small></span>
          </label>`).join('') + (reply.unmatched ? `<p class="note">Not matched: ${esc(reply.unmatched)}</p>` : '');
        fillDlg.querySelector<HTMLButtonElement>('[data-act="apply"]')!.hidden = !pending.some((c) => !c.problem);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        status.className = 'ai-status bad';
        status.textContent = errorText(err);
      } finally {
        controller = null;
      }
    } else if (act === 'apply') {
      const chosen = [...fillDlg.querySelectorAll<HTMLInputElement>('[data-i]:checked')].map((el) => pending[Number(el.dataset.i)]);
      store.commit((m) => applyChanges(m, chosen));
      fillDlg.close();
      message(`Applied ${chosen.length} change${chosen.length === 1 ? '' : 's'}. Undo reverts them.`);
    }
  });

  return {
    openSettings: () => openSettings(),
    suggestLayout: () => withKey(() => openLayout()),
    /** Right after a plan upload: ask first, and only ask for a key if the user says yes. */
    offerAfterUpload: () => openLayout(true),
    fillFromText: () => withKey(openFill),
  };
}
