# Central administrativa de backup — Campanha 0228

## Arquitetura

- A tela **Configurações → Sistema → Backup e Recuperação** chama `/api/admin/backup` e não exporta IndexedDB como se fosse PostgreSQL. A exportação Local-First continua em Configurações → Dados locais.
- A API exige sessão, `company.manage`, CSRF nas mutações, origem aprovada, MFA recente e uma allowlist de IDs de administradores provisionada no servidor. O navegador não recebe URL PostgreSQL, senha, chave, token externo nem caminho de filesystem.
- O processo HTTP grava uma fila JSON durável em diretório local privado/compartilhado e registra mutações em um arquivo JSONL privado. O processo `npm run backup:executor` executa recuperação, backup, verificação, inventário, publicação externa e restore de teste. Ele é iniciado separadamente pelo operador/supervisor do ambiente.
- Em instalação fora do teste, a API só habilita a fila quando o UID do executor difere do UID web e ambos pertencem ao grupo de controle dedicado. A chave, `pgpass`, URL de origem e token de storage ficam disponíveis somente ao usuário do executor. O diretório compartilhado usa grupo dedicado, modo `2770`; arquivos de controle são `0660`, sem permissões para outros usuários.
- Em `NODE_ENV=test` com `ROTAMOTO_DISPOSABLE_CAMPAIGN=0228`, a guarda permite harness local, mas o executor ainda rejeita fontes e alvos que não sejam bancos loopback `rotamoto_disposable_0228_*` com os papéis `rotamoto_backup` e `rotamoto_restore`. A restauração exige alvo vazio e valida ledger/checksums, constraints validadas, índices válidos e estado RLS/FORCE após o restore.

## Configuração do ambiente

Provisionar as contas/grupo e diretórios fora do processo HTTP. Não usar uma mesma conta Unix para servidor e executor. O grupo deve conter apenas essas identidades:

```sh
ROTAMOTO_BACKUP_CONTROL_DIRECTORY=/var/lib/rotamoto/backup-control
ROTAMOTO_BACKUP_CONTROL_GROUP_GID=<gid-do-grupo-dedicado>
ROTAMOTO_BACKUP_EXECUTOR_UID=<uid-do-executor>
ROTAMOTO_BACKUP_ADMIN_USER_IDS=<uuid-admin-1>,<uuid-admin-2>
ROTAMOTO_BACKUP_ADMIN_AUDIT_LOG=/var/log/rotamoto/backup-admin-audit.jsonl
```

O diretório de controle deve pertencer ao grupo dedicado e ter modo `2770`; o arquivo de auditoria precisa estar em diretório privado do usuário web. Se esses requisitos não forem atendidos, a API retorna indisponibilidade e não tenta reduzir os controles.

Somente o ambiente do executor recebe:

```sh
BACKUP_DATABASE_URL=postgresql://rotamoto_backup@<host-loopback>/<banco-descartavel-0228>
ROTAMOTO_BACKUP_KEY_FILE=<caminho-da-chave-do-ambiente-sintetico>
ROTAMOTO_BACKUP_DIRECTORY=<diretorio-privado-de-recovery-sets>
ROTAMOTO_MEDIA_DIRECTORY=<diretorio-privado-de-midias>
ROTAMOTO_DISPOSABLE_RESTORE_DATABASE_URL=postgresql://rotamoto_restore@<host-loopback>/<banco-vazio-descartavel-0228>
ROTAMOTO_DISPOSABLE_MEDIA_DIRECTORY=<destino-de-midias-descartavel>
ROTAMOTO_BACKUP_REMOTE_URL=<endpoint-HTTPS-autorizado>
ROTAMOTO_BACKUP_REMOTE_TOKEN=<token-do-executor>
```

Os valores acima são nomes de configuração, não credenciais. Não gravar valores reais no repositório. O adapter remoto usa protocolo HTTP de objeto com `PUT`, `HEAD` e publicação final do manifesto; o simulador loopback valida esse protocolo. Um destino real requer serviço compatível, credencial e autorização externa.

## Jobs e recuperação

O executor processa agendamento UTC diário/semanal e jobs persistidos. Jobs em `RUNNING` encontrados após reinício viram `UNKNOWN_OUTCOME`; não são repetidos automaticamente porque o efeito remoto pode ser incerto. O operador verifica o recovery set e enfileira nova operação com nova chave idempotente após diagnóstico. Locks órfãos com PID morto são recuperados; lock ou estado inválido bloqueia a fila.

Retenção roda apenas após criar e verificar o set novo e, quando configurado destino externo, após confirmação da publicação do manifesto. Falha no destino externo preserva os sets antigos. Sets incompletos e quarentenados nunca são apagados automaticamente.

Restore é exclusivamente um **teste em banco descartável vazio**: solicitação por um administrador, aprovação por outro administrador distinto com MFA recente e execução pelo usuário executor. O target precisa ser loopback, ter nome `rotamoto_disposable_0228_*`, papel `rotamoto_restore` e nenhum objeto de aplicação preexistente. O executor verifica integridade criptográfica, mídia, ledger, checksums, constraints, índices e flags/policies RLS. O projeto não oferece restauração operacional nesta campanha.

## Operação e limites

- Iniciar o executor como serviço dedicado, com usuário/UID próprio, e monitorar o evento JSON sanitizado `backup.executor.started|failed|stopped`.
- Não ativar agendamento até definir frequência, retenção, destino, chave, espaço e responsável operacional.
- A UI mostra RPO observado e RTO medido; metas são valores administrativos e não constituem SLA.
- As APIs administrativas estão desabilitadas se a separação de UID, grupo, auditoria ou allowlist estiver ausente.
- O teste `npm run test:backup-disposable-postgres` cria um cluster PostgreSQL temporário em loopback, aplica as 44 migrations versionadas, gera e verifica um recovery set criptografado sintético, restaura em banco descartável vazio e confere a linha de prova, ledger, constraints, índices e RLS/FORCE. Execução documentada em `browser-tests/evidencias/campanhas/0228/8283a577-04b1-4f4e-a269-a7d0eeff160e/backup-disposable-postgres-restore-attempt-5.json` (run `c202244a-bae1-48be-9ddc-0e14127cfcc3`). O cluster e a chave temporária foram removidos ao final; nenhum banco compartilhado foi usado.
- O Browser autenticado verificou a interface desktop/mobile, negação de usuário comum, configuração persistida e job manual durável em `QUEUED`, com replay idempotente. Ele não executou o executor: no Termux atual o servidor e o executor compartilham UID e não há identidade/grupo de serviço separado provisionado. Portanto scheduler operacional e execução de job por processo privilegiado permanecem desabilitados fora de teste.
- O adapter remoto foi validado por HTTP loopback e conferência `PUT`/`HEAD` de checksum; não houve cópia externa real. O destino e token remoto continuam provisionados apenas no ambiente do executor; a administração segura de credenciais de um destino externo ainda não está conectada ao painel.
- Esta campanha não acessou o PostgreSQL oficial, recovery set real, chave real ou destino externo. Restore comercial/operacional continua indisponível: a funcionalidade entregue solicita e executa somente teste em banco descartável, nunca sobre `rotamoto`, `rotamoto_e2e` ou outro alvo operacional.
