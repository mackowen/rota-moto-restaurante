(() => {
  'use strict';
  if (window.RotaMotoDialog) return;
  const queue = [];
  let active = null;

  function enqueue(config) {
    return new Promise(resolve => {
      queue.push({ config, resolve });
      processQueue();
    });
  }

  function processQueue() {
    if (active || !queue.length) return;
    const item = queue.shift();
    const { config, resolve } = item;
    const restoreFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'rm-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'rm-dialog-title');
    dialog.setAttribute('aria-describedby', 'rm-dialog-message');
    const card = document.createElement('section');
    card.className = 'rm-dialog-card';
    const heading = document.createElement('h2');
    heading.id = 'rm-dialog-title';
    heading.textContent = config.title || (config.kind === 'alert' ? 'Aviso' : config.kind === 'prompt' ? 'Informe os dados' : 'Confirme a ação');
    const message = document.createElement('p');
    message.id = 'rm-dialog-message';
    message.textContent = config.message || '';
    const error = document.createElement('p');
    error.className = 'rm-dialog-error';
    error.setAttribute('role', 'alert');
    error.setAttribute('aria-live', 'assertive');
    error.hidden = true;
    let field = null;
    if (config.kind === 'prompt') {
      if (Array.isArray(config.options)) {
        field = document.createElement('select');
        field.className = 'rm-dialog-field';
        for (const option of config.options) {
          const itemOption = document.createElement('option');
          itemOption.value = String(option.value);
          itemOption.textContent = String(option.label);
          field.append(itemOption);
        }
      } else {
        field = config.multiline ? document.createElement('textarea') : document.createElement('input');
        field.className = 'rm-dialog-field';
        if (field instanceof HTMLInputElement) field.type = config.inputType || 'text';
        if ('maxLength' in field && Number.isInteger(config.maxLength)) field.maxLength = config.maxLength;
        if ('value' in field) field.value = String(config.value ?? '');
        if (config.placeholder) field.placeholder = config.placeholder;
        if (config.multiline) field.rows = 4;
        if (config.inputMode) field.inputMode = config.inputMode;
      }
      field.setAttribute('aria-label', config.fieldLabel || config.title || 'Valor');
      card.append(field);
    }
    card.append(heading, message, error);
    const actions = document.createElement('div');
    actions.className = 'rm-dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'rm-dialog-cancel';
    cancel.textContent = config.cancelLabel || 'Cancelar';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = config.danger ? 'rm-dialog-confirm rm-dialog-confirm--danger' : 'rm-dialog-confirm';
    confirm.textContent = config.confirmLabel || (config.kind === 'prompt' ? 'Continuar' : config.kind === 'alert' ? 'Entendi' : 'Confirmar');
    if (config.kind !== 'alert') actions.append(cancel);
    actions.append(confirm);
    card.append(actions);
    dialog.append(card);
    document.body.append(dialog);

    const finish = value => {
      if (active?.dialog !== dialog) return;
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('click', onBackdrop);
      dialog.close();
      dialog.remove();
      active = null;
      if (restoreFocus instanceof HTMLElement && restoreFocus.isConnected && !restoreFocus.closest('[inert]')) restoreFocus.focus();
      resolve(value);
      queueMicrotask(processQueue);
    };
    const setError = text => {
      error.textContent = text;
      error.hidden = !text;
    };
    const onCancel = event => {
      event.preventDefault();
      if (!confirm.disabled && config.allowEscape !== false && config.kind !== 'alert') finish(config.kind === 'prompt' ? null : false);
    };
    const onBackdrop = event => {
      if (event.target === dialog && config.closeOnBackdrop === true && !confirm.disabled && config.kind !== 'alert') finish(config.kind === 'prompt' ? null : false);
    };
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('click', onBackdrop);
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.target === field) event.preventDefault();
    });
    cancel.addEventListener('click', () => finish(config.kind === 'prompt' ? null : false));
    confirm.addEventListener('click', async () => {
      if (confirm.disabled) return;
      const value = field ? field.value : true;
      if (config.kind === 'prompt' && typeof config.validate === 'function') {
        const validation = config.validate(value);
        if (validation !== true) { setError(typeof validation === 'string' ? validation : 'Revise o valor informado.'); field.focus(); return; }
      }
      confirm.disabled = true;
      cancel.disabled = true;
      confirm.dataset.label = confirm.textContent;
      confirm.textContent = config.loadingLabel || 'Aguarde…';
      setError('');
      try {
        const result = typeof config.onConfirm === 'function' ? await config.onConfirm(value) : undefined;
        finish(config.kind === 'prompt' ? value : config.kind === 'alert' ? true : { confirmed: true, result });
      } catch (cause) {
        setError(typeof config.errorMessage === 'function' ? config.errorMessage(cause) : config.errorMessage || 'Não foi possível concluir. Revise os dados e tente novamente.');
        confirm.disabled = false;
        cancel.disabled = false;
        confirm.textContent = confirm.dataset.label || config.confirmLabel || 'Confirmar';
        confirm.focus();
      }
    });
    active = { dialog, resolve };
    try {
      dialog.showModal();
      (field || cancel || confirm).focus();
    } catch (cause) {
      dialog.remove(); active = null; resolve(config.kind === 'prompt' ? null : false); queueMicrotask(processQueue);
    }
  }

  window.RotaMotoDialog = Object.freeze({
    confirm(options = {}) { return enqueue({ ...options, kind: 'confirm' }); },
    alert(options = {}) { return enqueue({ ...options, kind: 'alert' }); },
    prompt(options = {}) { return enqueue({ ...options, kind: 'prompt' }); }
  });
})();
