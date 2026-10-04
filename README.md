# backup-vault

Serviço próprio de **backup automático de bancos PostgreSQL** para um bucket S3 compatível (Backblaze B2 ou AWS S3).
Feito para rodar como um app no Coolify, **sem disco persistente**: toda a configuração e todo o histórico ficam
dentro do próprio bucket. Se você reconstruir ou apagar o app, é só apontar para o mesmo bucket e tudo volta.

- [Parte 1 – Guia em português (para quem não é técnico)](#parte-1--guia-em-português)
- [Parte 2 – Technical notes (English)](#part-2--technical-notes-english)

---

# Parte 1 – Guia em português

## 1. O que é isso?

Todo dia (no horário que você escolher) o backup-vault:

1. conecta em cada banco de dados cadastrado (ex.: `rex-db`, `parcel-db`...);
2. tira uma cópia completa do banco (`pg_dump`);
3. confere se a cópia está legível (`pg_restore --list`) e calcula uma "impressão digital" (SHA-256);
4. (opcional) **criptografa** a cópia com a sua senha antes de sair do servidor;
5. envia para o bucket (Backblaze B2) e anota o resultado;
6. apaga as cópias velhas seguindo a regra de retenção (padrão: **7 diárias + 4 semanais + 6 mensais**). A cópia mais recente **nunca** é apagada.

Se o servidor ficar desligado na hora do backup, ele **recupera** o backup assim que voltar. Se um banco falhar (senha errada, banco fora do ar),
o erro fica registrado e o painel `/status` mostra `failing`; se ficar muito tempo sem backup bom, mostra `stale`.

> A aba "Backups" dentro do admin do Harbor é feita separadamente; ela vai conversar com este serviço pela API (seção 8).

## 2. Quanto custa (Backblaze B2)?

Valores aproximados — **confira sempre em backblaze.com/cloud-storage/pricing**:

| Item | Preço aproximado |
|---|---|
| Armazenamento | ~US$ 6 a 7 por TB por mês (os primeiros 10 GB costumam ser grátis) |
| Envio (upload) | grátis |
| Download | grátis até ~3x o que você tem guardado por mês; só você baixa em caso de restauração |
| Operações (listar/ler) | centavos; o serviço guarda cache para fazer poucas chamadas |

Exemplo: 15 bancos de ~100 MB cada, com a retenção padrão (~17 cópias de cada) = ~25 GB → **menos de US$ 0,20 por mês**
(muitas vezes cai nos 10 GB grátis + centavos). Mesmo se cada banco tiver 1 GB, fica em torno de US$ 2 por mês.

## 3. Criar o bucket e a chave no Backblaze B2 (passo a passo)

> Os nomes dos botões podem mudar um pouco com o tempo, mas o caminho é este.

**3.1 Criar a conta**

1. Acesse **backblaze.com** → **Sign Up** → escolha **B2 Cloud Storage** → crie a conta e confirme o e-mail.
2. Ative a verificação em duas etapas (recomendado) e cadastre um cartão (o plano gratuito de 10 GB já funciona, mas o cartão evita bloqueio).

**3.2 Criar o bucket**

1. No menu da esquerda: **B2 Cloud Storage → Buckets → Create a Bucket**.
2. **Bucket Unique Name**: algo único no mundo, ex.: `jadson-backup-vault-2026` (só letras minúsculas, números e hífen).
3. **Files in Bucket are**: marque **Private**.
4. **Default Encryption**: pode deixar *Disable* (a criptografia forte é feita pelo próprio serviço, ver `BACKUP_ENCRYPTION_KEY`).
5. **Object Lock**: *Disable*.
6. Clique **Create a Bucket**.
7. Na lista de buckets, anote o **Endpoint** do bucket, algo como `s3.us-west-004.backblazeb2.com`.
   O trecho `us-west-004` é a **região**. Anote os dois.

**3.3 Muito importante: liberar espaço de verdade ao apagar**

O B2 guarda "versões" de arquivos. Para que a retenção realmente apague e você não pague por cópias velhas:

1. Em **Buckets**, clique em **Lifecycle Settings** do seu bucket.
2. Escolha **Keep only the last version of the file** e salve.

**3.4 Criar a chave de acesso (Application Key)**

1. Menu da esquerda: **Application Keys → Add a New Application Key**.
2. **Name of Key**: `backup-vault`.
3. **Allow access to Bucket(s)**: escolha o seu bucket (não use "All").
4. **Type of Access**: **Read and Write**. Deixe os outros campos em branco.
5. Clique **Create New Key**.
6. **Copie agora** o `keyID` e o `applicationKey` — o segundo **aparece só uma vez**. Guarde num gerenciador de senhas.
   - `keyID` → será o `S3_ACCESS_KEY_ID`
   - `applicationKey` → será o `S3_SECRET_ACCESS_KEY`

## 4. Colocar no ar no Coolify (v4)

1. No Coolify: **Projects →** seu projeto/ambiente **→ + New Resource → Private Repository (with GitHub App)** (ou *Public* se o repositório for público)
   e escolha o repositório **`digitalhunters02/backup-vault`**, branch **`main`**.
2. **Build Pack**: **Dockerfile**. **Ports Exposes**: `4000`.
3. **Não** adicione volume/Persistent Storage (o serviço não precisa).
4. **Rede**: o app precisa enxergar os bancos. Se os bancos estão no mesmo servidor/rede padrão do Coolify, o nome do container já resolve.
   Se der "could not translate host name" no teste do alvo, abra o app → **Advanced** → marque **Connect to Predefined Network**.
5. **Domínio**: opcional. O ideal é **não expor** o serviço na internet e deixar só o Harbor falar com ele pela rede interna.
   Se expor (ex.: `https://backup.seudominio.com`), a chave `BACKUP_API_KEY` é a única proteção — use uma chave longa.
6. Em **Environment Variables**, cole (troque os valores):

```env
S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
S3_REGION=us-west-004
S3_BUCKET=jadson-backup-vault-2026
S3_ACCESS_KEY_ID=<keyID do passo 3.4>
S3_SECRET_ACCESS_KEY=<applicationKey do passo 3.4>
S3_PREFIX=vault
BACKUP_API_KEY=<chave longa 1>
BACKUP_CONFIG_KEY=<chave longa 2>
BACKUP_ENCRYPTION_KEY=<chave longa 3, opcional mas recomendada>
TZ=America/Denver
PORT=4000
```

   **Como gerar as chaves longas**: use o gerador do seu gerenciador de senhas (40+ caracteres), ou no terminal `openssl rand -hex 32`.
   Cada uma deve ser diferente.

   > **Guarde `BACKUP_CONFIG_KEY` e `BACKUP_ENCRYPTION_KEY` num gerenciador de senhas, fora do servidor.**
   > Sem `BACKUP_ENCRYPTION_KEY` os arquivos `.enc` **não podem ser abertos por ninguém, nunca**. Sem `BACKUP_CONFIG_KEY` o serviço não consegue ler as senhas dos bancos guardadas no bucket (você teria que cadastrar os alvos de novo).

7. Clique **Deploy**. Quando terminar, abra os logs: deve aparecer `backup-vault listening on :4000` e `ready: 0 target(s)`.
8. Teste o armazenamento (de qualquer lugar que alcance o serviço; troque a URL e a chave):

```bash
curl -s -X POST -H "X-Backup-Key: SUA_BACKUP_API_KEY" http://backup-vault:4000/bucket/test
# esperado: {"ok":true,"steps":{"write":true,"read":true,"delete":true},...}
```

   Se vier `ok:false`, a mensagem diz o motivo (chave errada, bucket com outro nome, endpoint/região trocados...).

### Se o servidor do banco for mais novo que o `pg_dump` do serviço

O `pg_dump` precisa ser da **mesma versão do banco ou mais novo**. A imagem instala automaticamente o `postgresqlNN-client` **mais novo** disponível no Alpine.
Para fixar uma versão, crie a variável `PG_CLIENT_PACKAGE=postgresql17-client` marcada como **Build Variable** (disponível no build) e faça **Redeploy**.
O teste do alvo (`POST /targets/NOME/test`) mostra `pgDumpVersion`, `serverVersion` e `compatible`.

## 5. Cadastrar o primeiro banco (alvo)

1. No Coolify, abra o banco (ex.: **rex-db**) → aba **General** → copie a **Postgres URL (internal)**.
   Tem este formato: `postgres://usuario:senha@nome-do-container:5432/nome_do_banco`.
   (Use sempre a URL **interna**, não a pública.)
2. Cadastre o alvo (o serviço guarda a URL **criptografada** no bucket):

```bash
curl -s -X POST http://backup-vault:4000/targets \
  -H "X-Backup-Key: SUA_BACKUP_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "rex",
    "url": "postgres://usuario:senha@abc123xyz:5432/rex",
    "schedule": { "type": "daily", "time": "03:00" },
    "retention": { "daily": 7, "weekly": 4, "monthly": 6 }
  }'
```

   - `name`: letras minúsculas, números, `-` e `_`.
   - `schedule`: `{"type":"daily","time":"03:00"}` (todo dia às 03:00 no fuso `TZ`) **ou** `{"type":"interval","everyHours":6}` (a cada 6 horas).
   - `retention`: quantas cópias diárias/semanais/mensais manter (padrão 7/4/6).
3. Teste a conexão: `curl -s -X POST -H "X-Backup-Key: ..." http://backup-vault:4000/targets/rex/test` → deve vir `"ok": true`.
4. Rode o primeiro backup agora: `curl -s -X POST -H "X-Backup-Key: ..." "http://backup-vault:4000/targets/rex/run?wait=true"`.
   (Sem `wait=true` ele só enfileira e você acompanha em `/targets/rex/runs`.)
5. Veja o resumo: `curl -s -H "X-Backup-Key: ..." http://backup-vault:4000/status`.
   Um alvo recém-criado faz o primeiro backup sozinho em até 1 minuto.

**Atalho para o primeiro start:** a variável opcional `BACKUP_TARGETS_JSON` (lista JSON de alvos) cadastra os alvos automaticamente
**apenas se o bucket ainda não tiver configuração**. Exemplo no `.env.example`.

## 6. Como saber se está tudo certo

- `GET /status` → `"status": "healthy"` (tudo bem), `"stale"` (algum alvo sem backup bom há mais de 2x o intervalo + 1h) ou `"failing"` (a última tentativa de algum alvo falhou).
- Cada alvo mostra `lastSuccess`, `lastRun`, `nextRunAt` e `storedBytes`.
- No B2 você verá as pastas `vault/<alvo>/AAAA/MM/` com os arquivos `.dump` (ou `.dump.enc`).

Problemas comuns (aparecem no campo `error` de `/targets/NOME/runs`):

| Mensagem | O que fazer |
|---|---|
| `password authentication failed` | Senha da URL errada — atualize com `PUT /targets/NOME` `{"url":"..."}` |
| `could not translate host name` | O app não enxerga o banco: use a URL interna e marque *Connect to Predefined Network* |
| `server version mismatch` | `pg_dump` mais velho que o banco — ver "Se o servidor do banco for mais novo" |
| `AccessDenied` / `InvalidAccessKeyId` no `/bucket/test` | Chave do B2 errada ou sem permissão no bucket |
| `BACKUP_CONFIG_KEY does not match` | Você trocou a `BACKUP_CONFIG_KEY`. Volte a original (nada foi apagado) |

## 7. Como restaurar um backup (passo a passo)

> **Regra de ouro:** restaure primeiro num banco **novo/vazio** (ex.: `rex_restaurado`), confira, e só depois decida substituir o de produção.
> Restaurar por cima de um banco em uso pode apagar dados mais novos que o backup.

Você precisa de um lugar com `pg_restore` instalado e acesso ao banco. O jeito mais fácil: no Coolify abra o app **backup-vault → Terminal**
(a imagem já tem `pg_restore`, `psql` e o script de descriptografia).

**Passo 1 – Descobrir o arquivo**

```bash
curl -s -H "X-Backup-Key: SUA_BACKUP_API_KEY" http://localhost:4000/targets/rex/backups
```

Escolha o `key` do backup desejado (o mais novo vem primeiro).

**Passo 2 – Baixar** (link temporário de 10 minutos)

```bash
curl -s -H "X-Backup-Key: SUA_BACKUP_API_KEY" \
  "http://localhost:4000/backups/download-url?key=vault/rex/2026/10/rex-20261004T090000Z.dump.enc"
# copie o campo "url" e baixe:
cd /tmp && wget -O rex.dump.enc "COLE_A_URL_AQUI"
```

**Passo 3 – Descriptografar** (só se o arquivo termina em `.enc`)

```bash
cd /app
BACKUP_ENCRYPTION_KEY='sua chave' node scripts/decrypt.mjs /tmp/rex.dump.enc /tmp/rex.dump
```

O script mostra `sha256: ...`. Compare com o campo `sha256` do registro do backup em `GET /targets/rex/runs`: se for igual, o arquivo está íntegro.
(Se a chave estiver errada ou o arquivo tiver sido alterado, ele para com erro e não cria arquivo.)

**Passo 4 – Descompactar (`gunzip`)**: **não é necessário.** O arquivo `.dump` já é o formato "custom" do `pg_dump`, que é comprimido por dentro.
Se você usa um backup antigo feito por outra ferramenta e o arquivo termina em `.gz`, aí sim rode `gunzip arquivo.gz`.

**Passo 5 – Restaurar com `pg_restore`**

```bash
# 5a. criar um banco novo e vazio (use a URL do servidor com um usuário que possa criar bancos)
psql "postgres://usuario:senha@host:5432/postgres" -c "CREATE DATABASE rex_restaurado;"

# 5b. restaurar
pg_restore --no-owner --exit-on-error -d "postgres://usuario:senha@host:5432/rex_restaurado" /tmp/rex.dump

# 5c. conferir
psql "postgres://usuario:senha@host:5432/rex_restaurado" -c "SELECT count(*) FROM alguma_tabela;"
```

Para restaurar **por cima** do banco existente (cuidado!): pare o CRM e use
`pg_restore --clean --if-exists --no-owner -d "URL_DO_BANCO" /tmp/rex.dump`.

**Alternativa com `psql` (gerar um arquivo SQL):**

```bash
pg_restore --no-owner -f /tmp/rex.sql /tmp/rex.dump
psql "postgres://usuario:senha@host:5432/rex_restaurado" -f /tmp/rex.sql
```

**Passo 6 – Apagar os arquivos temporários** (`rm /tmp/rex.dump /tmp/rex.dump.enc /tmp/rex.sql`), pois contêm seus dados.

> Fora do Coolify: baixe o repositório (`git clone`), rode `npm ci --omit=dev` e use `node scripts/decrypt.mjs` do mesmo jeito (precisa de Node 22).

## 8. API (para a aba do Harbor)

Todas as chamadas (exceto `/health`) exigem o cabeçalho `X-Backup-Key: <BACKUP_API_KEY>`. Respostas em JSON.

| Método e rota | Para quê |
|---|---|
| `GET /health` | `{ok:true}` — sem autenticação |
| `GET /status` | Resumo geral (`healthy`/`stale`/`failing`), por alvo: último sucesso, última execução, próxima execução, bytes guardados; total no bucket. `?refresh=true` recarrega do bucket |
| `GET /targets` · `POST /targets` | Listar / criar alvos (URL sempre mascarada: `postgres://user:***@host:5432/db`) |
| `GET /targets/:nome` · `PUT /targets/:nome` · `DELETE /targets/:nome` | Ver / alterar (parcial: `url`, `schedule`, `retention`, `enabled`) / remover (`?deleteBackups=true` apaga também os arquivos; por padrão eles ficam no bucket) |
| `POST /targets/:nome/test` | Testa conexão (`pg`) e `pg_dump --schema-only`; informa versões e compatibilidade |
| `POST /targets/:nome/run` | Backup agora (`202` enfileirado; `?wait=true` espera e devolve o registro). `409` se já estiver rodando/na fila |
| `GET /targets/:nome/runs?limit=20` | Histórico de execuções (mais novas primeiro) |
| `GET /targets/:nome/backups` | Arquivos no bucket (chave, tamanho, data, se é criptografado) |
| `GET /backups/download-url?key=…` | Link de download válido por 10 minutos |
| `DELETE /backups?key=…` | Apaga um backup manualmente (recusa o mais recente do alvo) |
| `POST /bucket/test` | Grava, lê e apaga um arquivinho para validar as credenciais |

Regra de "stale": o alvo está `stale` se o último backup bom for mais velho que **2x o intervalo + 1 hora** (diário = 49 h; a cada 6 h = 13 h).

## 9. Segurança em poucas palavras

- Senhas dos bancos: guardadas **criptografadas** (AES-256-GCM) no bucket, nunca aparecem em logs, erros ou respostas da API.
- Dumps: com `BACKUP_ENCRYPTION_KEY`, o arquivo no bucket é ilegível sem a chave (e detecta adulteração).
- A chave de acesso do B2 deve ter acesso **só a este bucket**.
- Quem tem a `BACKUP_API_KEY` pode baixar seus backups: não exponha o serviço sem necessidade.

---

# Part 2 – Technical notes (English)

## What it is

A small stateless Node 22 (ESM) service. It schedules and runs `pg_dump -Fc` for a list of PostgreSQL targets, uploads the dumps to an S3-compatible bucket
and keeps *all* of its state (targets, run history) in that bucket. No database, no volume. Dependencies: `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`,
`@aws-sdk/s3-request-presigner`, `pg`. The HTTP server is plain `node:http`. Dev dependency: `s3rver` (S3 emulator for tests).

## Bucket layout (everything under `S3_PREFIX`, default `vault`)

```
vault/_vault/config.json                     targets; connection URLs AES-256-GCM encrypted with BACKUP_CONFIG_KEY (+ key check value)
vault/_vault/runs/<target>/<ts>.json         run record: status, startedAt, finishedAt, durationMs, sizeBytes, sha256, key, error, verified, ...
vault/<target>/<YYYY>/<MM>/<target>-<ts>.dump[.enc]
```

`<ts>` is UTC `YYYYMMDDTHHMMSSZ`. Run record fields: `sha256` = SHA-256 of the **plaintext** dump (compare it with the output of `scripts/decrypt.mjs`),
`storedSha256`/`sizeBytes` = what is actually stored (ciphertext if encrypted), `plaintextSizeBytes`, `encrypted`, `verified`, `pgDumpVersion`, `trigger` (`schedule|manual`), `status` (`success|failed`).

## Run pipeline

`pg_dump -Fc -f <tmp>` → `pg_restore --list <tmp>` (must succeed and list objects → `verified:true`) → SHA-256 → (optional chunked AES-256-GCM encryption) →
streamed multipart upload (8 MiB parts, 2 in flight; memory stays small) → size check (HEAD) → run record → retention pruning.

The dump goes through a **temp file** (`BACKUP_TMP_DIR`, default OS tmp, removed in a `finally`) instead of a pipe on purpose: verification must happen
before anything is uploaded, a failed dump never leaves a partial object in the bucket, and seekable custom-format archives support `pg_restore -j`.
You need free disk space of about the compressed dump size. Credentials are passed to `pg_dump` through `PG*` environment variables (never argv) and the child
environment contains no S3 secrets. All log lines, errors and API output pass through `redact()`.

## Dump encryption format (`.enc`)

`"BVLT" | version=1 | chunkSize u32 | salt(16) | noncePrefix(8)` then frames `u32(len|FINAL_BIT) | ciphertext | tag(16)`.
Key = `BACKUP_ENCRYPTION_KEY` used raw if it is 64 hex chars, otherwise `scrypt(secret, salt, N=16384)`. IV = noncePrefix + frame counter; AAD = header + final flag,
so truncation, reordering and tampering are detected. Decrypt with `scripts/decrypt.mjs` (see the Portuguese restore section).

## Scheduling

- `daily` (`HH:MM` in `TZ`): due when the most recent slot is newer than the last successful run's start → one run per slot, automatic catch-up after downtime, DST-safe.
- `interval` (`everyHours`): due `N` hours after the last success.
- A target that never succeeded is due immediately. After a failure the target is retried after 1 hour.
- The tick runs every minute; last-run state is cached in memory (rebuilt from `_vault/runs/…` at startup) to keep the number of bucket LIST calls low.
- One run at a time (global queue); a target that is queued or running is never queued again.
- Retention (GFS, in the configured `TZ`): after each successful run keep the newest backup of each of the last `daily` days, `weekly` ISO weeks, `monthly` months that contain backups.
  The newest backup is always kept. Pruning deletes dump + its run record; orphan (failed) run records are deleted after 30 days.

## Environment

| Variable | Required | Default | Notes |
|---|---|---|---|
| `S3_ENDPOINT` | for B2/MinIO | – | e.g. `https://s3.us-west-004.backblazeb2.com`; empty = AWS |
| `S3_REGION` | no | derived from B2 endpoint, else `us-east-1` | |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | yes | – | |
| `S3_PREFIX` | no | `vault` | |
| `S3_FORCE_PATH_STYLE` | no | `true` with endpoint, else `false` | |
| `BACKUP_API_KEY` | yes (≥16 chars) | – | service refuses to start without it |
| `BACKUP_CONFIG_KEY` | yes (≥16 chars) | – | encrypts target URLs in the bucket |
| `BACKUP_ENCRYPTION_KEY` | no (≥16 chars) | – | set = every new dump is encrypted |
| `TZ` | no | `America/Denver` | scheduling and retention day boundaries |
| `PORT` | no | `4000` | |
| `BACKUP_TARGETS_JSON` | no | – | seeds targets only if the bucket has no config yet |
| `BACKUP_DUMP_TIMEOUT_MIN`, `BACKUP_TMP_DIR`, `BACKUP_SCHEDULER`, `PG_DUMP_PATH`, `PG_RESTORE_PATH` | no | 120 / OS tmp / on / `pg_dump` / `pg_restore` | |

The SDK is configured with `requestChecksumCalculation/responseChecksumValidation = WHEN_REQUIRED` because newer SDK defaults are rejected by several S3-compatible services.

## Docker / pg_dump version

`Dockerfile` (node:22-alpine) installs the newest `postgresql<N>-client` found by `apk search`. Override with build arg `PG_CLIENT_PACKAGE=postgresql16-client`.
`pg_dump` must be >= the server's major version; `POST /targets/:name/test` reports `pgDumpVersion`, `serverMajor` and `compatible`.

## Tests

```bash
npm ci
npm test      # node --test, runs serially (uses ports 4580 for the service and 4581 for the S3 emulator)
```

Unit tests need nothing external. The end-to-end tests (`test/e2e.test.js`) need a local PostgreSQL (`postgres://test:test@localhost:5432/postgres`, override with
`TEST_PG_ADMIN_URL`) with `pg_dump`/`pg_restore` on PATH; they create/drop the databases `vault_src`, `vault_restore`, `vault_big`. They start `s3rver` themselves.

## Limits / notes

- Logical backups only (no point-in-time recovery). Single instance only: two instances on one bucket would both run backups and the config is last-write-wins.
- Not exercised against real Backblaze B2 / AWS S3 in this repository's tests (only the s3rver emulator); use `POST /bucket/test` right after deploying.
- On B2 set the bucket lifecycle to "keep only the last version", otherwise deletions only hide files.
- No rate limiting on the API; keep it on the internal network or behind a strong `BACKUP_API_KEY`.
