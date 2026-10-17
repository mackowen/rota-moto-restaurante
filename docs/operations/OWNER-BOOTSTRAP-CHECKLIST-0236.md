# Checklist do primeiro proprietário — Campanha 0236

Não executar bootstrap nem enviar convite até todos os itens obrigatórios serem
confirmados. O banco oficial foi consultado em transação read-only nesta
campanha: zero usuários; latch de instalação presente. A confirmação do email
remetente SMTP, por si só, não autoriza criar proprietário.

## Gate operacional obrigatório

- [ ] Nome legal/comercial da empresa e identificação da instalação.
- [ ] Email do primeiro proprietário confirmado pelo operador.
- [ ] HTTPS definitivo e domínio DNS sob controle do proprietário.
- [ ] `PUBLIC_BASE_URL` aponta para HTTPS alcançável; nenhum link usa localhost.
- [ ] Certificado válido, proxy confiável restrito e origins/hosts exatos.
- [ ] SMTP `smtp-verify` aprovado; entrega do convite autorizada para o email confirmado.
- [ ] Keystore e envelopes recuperáveis; backup e auditoria privados.
- [ ] PostgreSQL official ledger 0047 e API oficial 8788 readiness OK.
- [ ] Autorização explícita do operador para executar
      `node scripts/bootstrap-owner.js --confirm-database=rotamoto`.

## Execução autorizada

O bootstrap requer terminal interativo, nome da empresa, email e a frase exata
`PROVISIONAR PRIMEIRO PROPRIETARIO`. Ele aceita apenas `rotamoto_app` no banco
`rotamoto`, grava auditoria e cria um convite de uso único após transação. Não
copie convite/token para logs ou tickets. Se o commit ocorrer e o envio falhar,
preserve a `operationKey` localmente e faça retry somente com os mesmos dados.

O proprietário ativa o convite, define senha, conclui TOTP/MFA e guarda códigos
de recuperação. Validar login, logout, sessão expirada e recuperação em Browser
após HTTPS. Não imprimir senha, token de convite, seed TOTP ou recovery codes.
