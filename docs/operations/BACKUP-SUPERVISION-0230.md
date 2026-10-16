# Supervisão do executor — Campanha 0230

## Princípios

O servidor HTTP registra operações autorizadas; somente o processo executor interpreta a fila durável e executa os tipos predefinidos. O executor mantém lock exclusivo, heartbeat e scheduler. Ao reiniciar, jobs `RUNNING` tornam-se `UNKNOWN_OUTCOME`; backup/restore incertos não são repetidos automaticamente. `scripts/backup-executor-health.js` verifica o heartbeat e a segurança dos arquivos do controle, sem conectar ao PostgreSQL. O endpoint administrativo continua sujeito a RBAC/MFA/CSRF.

## Termux sem root

Este runtime não tem root. O servidor e o executor pertencem ao mesmo UID Android; runit reinicia o processo e organiza logs, mas **não** cria uma fronteira de UID. Não tratar o executor Termux como equivalente à identidade dedicada Linux.

Arquivos versionados:

- `deploy/runit/backup-executor/run` inicia o executor em foreground para `runsv`.
- `deploy/runit/backup-executor/log/run` envia stdout/stderr ao `svlogd` local do serviço.
- `deploy/runit/backup-executor/check` verifica o heartbeat persistido.
- `deploy/termux-boot/rotamoto-runit.example.sh` é um exemplo opcional de inicialização por Termux:Boot.

Preparação manual: copie `run` e `check` para um diretório privado de serviço do usuário, crie o subdiretório `log` e coloque `log/run` nele; todos os arquivos executáveis devem pertencer ao UID do app e ter modo `0700`. Mantenha a configuração real fora do checkout, com modo `0600`, a chave separada do diretório de artefatos e `ROTAMOTO_BACKUP_EXECUTOR_ENV_FILE` apontando para esse arquivo antes de iniciar `runsvdir` privado. Crie o diretório de estado/artefatos com permissões privadas. Revise o exemplo antes de usá-lo; ele contém valores de exemplo e não é uma configuração de produção.

`sv status <service>` verifica o processo; `<service>/check` verifica heartbeat/readiness do executor. `sv restart <service>` reinicia com recuperação conservadora; para parada, use `sv -w 30 down <service>` e depois `sv exit <service>`. O template de Termux:Boot não foi copiado para `~/.termux/boot` e nenhum serviço global foi alterado. A inicialização após boot requer Termux:Boot instalado/configurado pelo operador.

Logs são mantidos no diretório do serviço sob `svlogd`; nesta versão do runit o arquivo `current` é criado com modo `0744`, mas o diretório de serviço e o diretório `log` precisam permanecer `0700`, impedindo que outros UIDs atravessem o caminho. O E2E confirmou os modos dos diretórios. Não coloque esses logs em diretório compartilhado sem aplicar e validar uma política de arquivos mais restritiva. Audite também rotação e espaço local. O painel distingue executor `ONLINE`, `STALE`, `OFFLINE` e `UNKNOWN`. Em shared UID, qualquer processo comprometido sob o mesmo app UID ainda pode alcançar os mesmos arquivos/processos; minimize o que o processo HTTP recebe e mantenha dados operacionais desabilitados até a aceitação explícita desse risco.

## Linux com systemd

`deploy/systemd/rotamoto-backup-executor.service` é um modelo, não instalado. Antes de habilitá-lo, provisionar usuário `rota-backup` e grupo dedicado `rota-backup-control`, atribuir UID/GID reais, configurar diretórios `2770` pertencentes ao grupo, arquivo de ambiente `root:rota-backup` modo `0640` ou mais restritivo e chave apenas legível pelo executor. O servidor HTTP deve ter UID distinto e acesso apenas ao IPC/controle previsto. Revisar `ReadWritePaths`, `/opt` e caminhos do secret store para a implantação local. O serviço usa `Restart=on-failure`, `SIGTERM`, timeout de parada e `ExecStartPost` sanitizado para health check.

Comandos de implantação, após revisão e autorização no host: instalar o unit em `/etc/systemd/system`, `systemctl daemon-reload`, `systemctl enable --now rotamoto-backup-executor`, depois `systemctl status` e `journalctl -u rotamoto-backup-executor`. Nenhum desses comandos foi executado nesta campanha; `systemctl` não existe no ambiente Android atual.

## Docker/contêiner

`deploy/docker/backup-executor.Dockerfile` constrói uma imagem runtime não-root, com UID/GID configuráveis, filesystem somente leitura compatível com volumes persistentes, capabilities removidas e health check. `backup-executor.compose.example.yml` fixa usuário, política de restart, limites, `no-new-privileges`, volumes separados e mount somente leitura da chave. O arquivo de ambiente e o caminho da chave devem ser administrados no host e nunca incorporados à imagem. Usar destino PostgreSQL explícito, TLS quando cruzar hosts e secrets montados somente no executor.

Docker/Podman não estão instalados neste Termux; build, health check e restart real de contêiner não foram exercitados. O compose é um modelo para revisão, não foi aplicado.

## Evidência 0230

O E2E cria configuração privada dentro do diretório único do run e inicia `runsv` diretamente sobre o serviço temporário (não usa `runsvdir` global). Chromium/CDP usa sessões sintéticas autenticadas; runtime, worker, fonte e destino PostgreSQL são isolados e sintéticos. O runner verifica job manual e automático `SUCCEEDED`, heartbeat, health check, supervisor, crash/restart, restore duplamente aprovado e ausência de duplicação. O processo supervisionado e o app compartilham UID `10436`, confirmado em `/proc`; isso comprova a limitação de isolamento Termux, não uma fronteira de segurança. Capturas e logs sanitizados ficam no diretório de evidência 0230. Resultado em Linux e contêiner só pode ser PASS após execução nesses ambientes.
