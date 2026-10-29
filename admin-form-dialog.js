(() => {
  'use strict';
  if (window.RotaMotoAdminFormDialog) return;
  let sequence = 0;

  function create({ source, form, title, description, triggerLabel, submitButton }) {
    if (!source || !form || !submitButton) return null;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'rm-primary rm-admin-dialog-trigger';
    trigger.textContent = triggerLabel;

    const dialog = document.createElement('dialog');
    dialog.className = 'rm-admin-form-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const id = ++sequence;
    const titleId = `rm-admin-form-title-${id}`;
    const descriptionId = `rm-admin-form-description-${id}`;
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.setAttribute('aria-describedby', descriptionId);

    const shell = document.createElement('section');
    shell.className = 'rm-admin-form-dialog__shell';
    const head = document.createElement('header');
    head.className = 'rm-admin-form-dialog__head';
    const heading = document.createElement('h2');
    heading.id = titleId;
    heading.textContent = title;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'rm-admin-dialog-close';
    close.setAttribute('aria-label', `Fechar: ${title}`);
    close.textContent = '×';
    head.append(heading, close);

    const help = document.createElement('p');
    help.className = 'rm-admin-form-dialog__description';
    help.id = descriptionId;
    help.textContent = description;
    const body = document.createElement('div');
    body.className = 'rm-admin-form-dialog__body';
    const actions = document.createElement('footer');
    actions.className = 'rm-admin-form-dialog__actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'rm-secondary';
    cancel.textContent = 'Cancelar';

    const formId = `rm-admin-dialog-form-${id}`;
    form.id = formId;
    form.classList.add('rm-admin-form-dialog__form');
    form.dataset.dialogDirty = '';
    form.querySelector('h3')?.remove();
    const redundantDescription = form.querySelector(':scope > p');
    if (redundantDescription && !redundantDescription.hasAttribute('role')) redundantDescription.remove();
    const result = form.querySelector('[data-invite-result],[data-role-result]');
    if (result) result.hidden = true;
    submitButton.remove();
    submitButton.setAttribute('form', formId);
    actions.append(cancel, submitButton);
    body.append(form);
    shell.append(head, help, body, actions);
    dialog.append(shell);
    source.replaceWith(trigger, dialog);

    let closePending = false;
    const closeDialog = async ({ discard = false, force = false } = {}) => {
      if (dialog.dataset.busy === 'true' || closePending) return;
      if (!force && form.dataset.dialogDirty === 'true') {
        closePending = true;
        try {
          const result = await window.RotaMotoDialog?.confirm({
            title: 'Descartar alterações?',
            message: 'As informações ainda não foram salvas. Deseja fechar e descartar o que foi preenchido?',
            danger: true,
            confirmLabel: 'Descartar alterações'
          });
          if (!result?.confirmed) return;
        } finally { closePending = false; }
      }
      if (discard) { form.reset(); form.dataset.dialogDirty = ''; }
      if (dialog.open) dialog.close();
    };
    trigger.addEventListener('click', () => {
      if (dialog.open) return;
      const feedback = dialog.closest('[data-admin-subpage]')?.querySelector('[data-team-feedback]');
      if (feedback) feedback.textContent = '';
      dialog.showModal();
      (form.querySelector('input:not([type="hidden"]),select,textarea') || cancel).focus();
    });
    close.addEventListener('click', () => { void closeDialog({ discard: true }); });
    cancel.addEventListener('click', () => { void closeDialog({ discard: true }); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); void closeDialog({ discard: true }); });
    dialog.addEventListener('click', event => { if (event.target === dialog) void closeDialog({ discard: true }); });
    dialog.addEventListener('close', () => { if (trigger.isConnected) trigger.focus(); });
    form.addEventListener('input', () => { form.dataset.dialogDirty = 'true'; });
    form.addEventListener('change', () => { form.dataset.dialogDirty = 'true'; });
    return {
      dialog,
      trigger,
      close: () => closeDialog({ force: true }),
      markSaved: () => { form.dataset.dialogDirty = ''; if (dialog.open) dialog.close(); }
    };
  }

  window.RotaMotoAdminFormDialog = Object.freeze({ create });
})();
