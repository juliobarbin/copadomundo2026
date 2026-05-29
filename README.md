# 🏆 Bolão da Copa 2026

Site de bolão da Copa do Mundo de 2026 com os **12 grupos oficiais**, login com **conta Google**, palpites de **placar exato** com pontuação e **ranking** automático.

- **Frontend:** HTML + CSS + JavaScript puro (sem build).
- **Backend / Banco / Login:** [Supabase](https://supabase.com) (PostgreSQL + Auth Google) — plano **gratuito**.
- **Hospedagem:** [Vercel](https://vercel.com) (estática) — plano **gratuito**. *(Netlify ou GitHub Pages também funcionam.)*

## Pontuação
| Pontos | Quando |
|--------|--------|
| **+10** | Placar exato (ex.: palpitou 2×1 e foi 2×1) |
| **+5**  | Acertou o resultado (vencedor/empate), mas não o placar |
| **+0**  | Errou o resultado |

---

## Passo a passo (≈ 20 min, tudo grátis)

### 1) Criar o projeto no Supabase
1. Acesse <https://supabase.com> → **Start your project** (entre com o Google/GitHub).
2. **New project**. Dê um nome, escolha uma senha de banco e a região (South America se disponível). Aguarde ~2 min.

### 2) Criar as tabelas e popular os jogos
1. No menu lateral: **SQL Editor → New query**.
2. Cole **todo** o conteúdo de [`supabase/schema.sql`](supabase/schema.sql) e clique em **Run**.
3. Abra outra query, cole **todo** o conteúdo de [`supabase/seed.sql`](supabase/seed.sql) e **Run**. *(Isso insere os 72 jogos da fase de grupos.)*

> Para regenerar os jogos: `node scripts/gen-seed.mjs`.

### 3) Ativar o login com Google
**a) No Google Cloud Console** (<https://console.cloud.google.com>):
1. Crie um projeto (ou use um existente) → **APIs e Serviços → Tela de consentimento OAuth**. Tipo **Externo**, preencha nome do app e e-mail, salve.
2. **Credenciais → Criar credenciais → ID do cliente OAuth → Aplicativo da Web**.
3. Em **URIs de redirecionamento autorizados**, adicione a URL de callback do Supabase:
   `https://SEU_PROJETO.supabase.co/auth/v1/callback`
   *(pegue a URL exata no próximo passo, no Supabase).*
4. Copie o **Client ID** e o **Client Secret**.

**b) No Supabase:** **Authentication → Sign In / Providers → Google** → ative, cole o **Client ID** e **Client Secret** e salve. Copie a *callback URL* mostrada ali e confira se bate com a do passo a.3.

**c) URLs do site:** **Authentication → URL Configuration** → em **Site URL** e **Redirect URLs**, adicione:
- `http://localhost:5173` (para testar localmente)
- a URL final da Vercel (ex.: `https://seu-bolao.vercel.app`)

### 4) Conectar o site ao Supabase
1. Em **Settings → API** (Data API), copie a **Project URL** e a **anon public key**.
2. Edite [`js/config.js`](js/config.js) e cole os dois valores.

### 5) Testar localmente
Na pasta do projeto:
```bash
npx serve .
# ou: python3 -m http.server 5173
```
Abra o endereço mostrado e clique em **Entrar com Google**.

### 6) Publicar grátis na Vercel
1. Suba a pasta para um repositório no GitHub.
2. Em <https://vercel.com> → **Add New → Project** → importe o repositório.
3. *Framework Preset:* **Other**. Sem build. **Deploy**.
4. Copie a URL gerada e adicione-a no Supabase (passo 3c). Pronto! 🎉

> Alternativa sem GitHub: instale `npm i -g vercel` e rode `vercel` na pasta.

---

## Como lançar os resultados dos jogos (admin)
Você (ou quem for o organizador) precisa virar **admin** uma vez:

1. Faça login no site pelo menos uma vez (para criar seu usuário).
2. No Supabase: **SQL Editor**, rode (troque pelo seu e-mail):
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'seu-email@gmail.com';
   ```
3. Recarregue o site: aparecerá a aba **⚙️ Admin**, onde você digita o placar oficial de cada jogo. Ao salvar, a pontuação de todos é recalculada automaticamente.

---

## Estrutura
```
copadomundo2026/
├── index.html              # página única
├── css/style.css           # visual
├── js/
│   ├── config.js           # URL + anon key do Supabase (você edita)
│   └── app.js              # toda a lógica (auth, palpites, ranking, admin)
├── supabase/
│   ├── schema.sql          # tabelas, RLS, função de pontos, ranking
│   └── seed.sql            # 72 jogos da fase de grupos (gerado)
├── scripts/gen-seed.mjs    # gerador do seed.sql
├── vercel.json
└── README.md
```

## Segurança
A *anon key* é pública por design — o acesso é controlado por **Row Level Security** no banco: cada um só edita o próprio perfil/palpites, palpites fecham no horário do jogo, e só admins lançam resultados.
