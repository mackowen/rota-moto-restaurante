# Implantação local no Termux

Este procedimento opera apenas em loopback no Termux. `NODE_ENV=development` é
um modo local e não equivale a homologação de produção.

## Serviços e bancos

| Processo | Endereço | Banco | Função |
|---|---|---|---|
| API E2E | `127.0.0.1:8787` | `rotamoto_e2e` | Testes e Browser QA |
| API local | `127.0.0.1:8788` | `rotamoto` | API local dos aplicativos |
| Restaurante | `127.0.0.1:8081` | via API local | Painel web |
| Motoboy | `127.0.0.1:8082` | via API local | Aplicativo web |

A API oficial usa exclusivamente `rotamoto_app` e `.pgpass` 0600; nunca recebe
`MIGRATOR_DATABASE_URL`. A configuração aceita apenas o URL local fixo para
`rotamoto`. O serviço E2E mantém seu ambiente limpo e não recebe configuração
do banco oficial. O CLI de operador e a API são contextos separados: caminhos
do keystore disponíveis no CLI não aparecem na configuração HTTP de
development nem em test/E2E.

## Instalação e supervisão runit

Copie `deploy/termux/official-api.env.example` para
`~/rotamoto-data/official-api/runtime.env`, confirme os caminhos locais, crie
a pasta com modo 0700 e o arquivo com modo 0600. Instale o serviço de
`deploy/runit/rotamoto-api-official` em `$PREFIX/var/service` e crie o log
privado em `$PREFIX/var/log/sv/rotamoto-api-official`, também modo 0700. O
script recusa arquivo de ambiente ou `.pgpass` com dono/modo incorreto,
qualquer banco diferente do oficial, listener diferente de loopback ou
`MIGRATOR_DATABASE_URL`.

Use `sv status rotamoto-api-official`, `sv restart rotamoto-api-official` e
`sv down rotamoto-api-official` para supervisionar. `sv up` reabilita o serviço
após `down`. O runit do Termux supervisiona a inicialização do app; não é
necessário instalar Termux:Boot nem alterar configuração Android. Shutdown usa
SIGTERM e o lifecycle existente da API.

Os logs são sanitizados pela aplicação e rotacionados por `svlogd` em diretório
privado. O supervisor e o servidor compartilham o UID Android do Termux; isso
não equivale a isolamento de usuário Linux dedicado.

## Nginx local

Os dois sites devem ouvir somente `127.0.0.1`. Os templates
`deploy/termux/nginx/rotamoto-restaurante.conf` e
`rotamoto-motoboy.conf` encaminham `/api/` para `127.0.0.1:8788`. O welcome
server deve ouvir `127.0.0.1:8080`. O endpoint `8787` continua exclusivo do
serviço E2E e não é usado pelos sites operacionais. Os caminhos permitem apenas
arquivos estáticos conhecidos; `manifest.json` do Restaurante é explicitamente
servido. Cabeçalhos estáticos são incluídos por
`rotamoto-security-headers.conf`; a API aplica seus próprios cabeçalhos.

Antes de recarregar Nginx, guarde cópia privada dos arquivos ativos, execute
`nginx -t` e valide `/`, `/manifest.json`, assets e `/api/health/ready` nas duas
interfaces. Reinicie o serviço gerenciado com `sv restart nginx`: neste
ambiente, `nginx -s reload` não atualizou o processo supervisionado pelo runit.
A configuração atual não expõe serviços pela LAN nem pela internet.

## SMTP, keystore e primeiro proprietário

`npm run operator` usa o contexto CLI explícito. Ele lê somente o arquivo
privado `~/rotamoto-data/identity/operator.env` (opções permitidas:
`SMTP_USER`, `SMTP_FROM`, `PUBLIC_BASE_URL`) e a referência privada já guardada
em `keys/smtp-password.ref`; o valor da senha é lido do keystore apenas em
memória para `smtp-verify`. O arquivo de opções deve ser próprio do usuário,
sem symlink, modo 0600 e não contém senhas ou referências. O endpoint HTTP e o
serviço E2E não carregam esses paths ou valores.

A verificação SMTP usa `smtp.gmail.com:465`, TLS implícito validado e
autenticação explícita. Ela não envia email e não exige `PUBLIC_BASE_URL`; o
envio de convite/recovery exige remetente e URL HTTPS pública válidos. Não
configure endereço ou domínio presumidos. Bootstrap real, convite e primeiro
proprietário continuam bloqueados até autorização específica e HTTPS público
válido.

Use o checklist [OWNER-BOOTSTRAP-CHECKLIST-0236.md](OWNER-BOOTSTRAP-CHECKLIST-0236.md)
antes de iniciar a criação da primeira conta. A sequência de recovery do
PostgreSQL, identity envelopes e serviços em outro Termux/Linux está em
[RECOVERY-TERMUX-LINUX-0236.md](RECOVERY-TERMUX-LINUX-0236.md).

## Acesso remoto e produção

As interfaces e API estão limitadas a loopback. Android/Termux não permite
separar serviços por UID como Linux dedicado. Para outros dispositivos use
futuramente domínio/DNS, HTTPS com certificado válido e proxy autenticado ou
VPN/túnel aprovado; não altere o bind para `0.0.0.0` como atalho. Links de
convite nunca devem usar `https://localhost`.

Linux/systemd e Docker/Compose seguem como artefatos de implantação futuros.
SMTP externo, HTTPS público, storage externo, primeira conta real e DR
independente exigem infraestrutura e/ou autorização próprias; não são provados
por este modo local.
