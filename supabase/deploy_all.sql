-- ============================================================
-- DEPLOY COMPLETO — Bolão Copa 2026
-- Cole TUDO isto no Supabase: SQL Editor > New query > Run
-- (cria tabelas/RLS/funções e insere os 72 jogos)
-- ============================================================

-- ============================================================
--  BOLÃO COPA 2026 — Esquema do banco (Supabase / PostgreSQL)
--  Rode este arquivo no Supabase: SQL Editor > New query > Run
-- ============================================================

-- ---------- Tabelas ----------

-- Perfil do usuário (espelha auth.users, criado no primeiro login)
create table if not exists public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  full_name   text,
  avatar_url  text,
  email       text,
  created_at  timestamptz default now()
);

-- Lista de administradores (quem pode lançar resultados oficiais).
-- Sem políticas de escrita p/ clientes: só pelo painel/SQL (seguro).
create table if not exists public.admins (
  user_id uuid primary key references auth.users on delete cascade
);

-- Jogos da fase de grupos
create table if not exists public.matches (
  id          bigint generated always as identity primary key,
  group_code  text   not null,          -- 'A' .. 'L'
  matchday    int    not null,          -- 1, 2 ou 3
  home_team   text   not null,
  away_team   text   not null,
  home_iso    text,                     -- código da bandeira (flagcdn)
  away_iso    text,
  match_date  timestamptz,              -- data/hora do jogo (fecha o palpite)
  home_score  int,                      -- placar oficial (null = não jogou)
  away_score  int,
  status      text   not null default 'scheduled'  -- scheduled | finished
);

-- Palpites dos usuários
create table if not exists public.predictions (
  id          bigint generated always as identity primary key,
  user_id     uuid   not null references auth.users on delete cascade,
  match_id    bigint not null references public.matches on delete cascade,
  home_score  int    not null,
  away_score  int    not null,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  unique (user_id, match_id)
);

-- ---------- Função de pontuação ----------
-- Placar exato = 10 | Acertou resultado (vencedor/empate) = 5 | Errou = 0
create or replace function public.calc_points(ph int, pa int, ah int, aa int)
returns int language sql immutable as $$
  select case
    when ph is null or pa is null or ah is null or aa is null then 0
    when ph = ah and pa = aa then 10
    when sign(ph - pa) = sign(ah - aa) then 5
    else 0
  end;
$$;

-- ---------- View do ranking ----------
create or replace view public.leaderboard as
select
  pr.id                                                        as user_id,
  pr.full_name,
  pr.avatar_url,
  coalesce(sum(public.calc_points(p.home_score, p.away_score,
                                  m.home_score, m.away_score)), 0) as total_points,
  count(p.id) filter (where m.status = 'finished')             as scored_matches,
  count(p.id) filter (where m.status = 'finished'
        and p.home_score = m.home_score
        and p.away_score = m.away_score)                       as exact_hits
from public.profiles pr
left join public.predictions p on p.user_id = pr.id
left join public.matches m     on m.id = p.match_id and m.status = 'finished'
group by pr.id, pr.full_name, pr.avatar_url
order by total_points desc, exact_hits desc;

-- ---------- Auto-criação do perfil no cadastro ----------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, avatar_url, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url',
    new.email
  )
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- updated_at automático ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_predictions_touch on public.predictions;
create trigger trg_predictions_touch
  before update on public.predictions
  for each row execute function public.touch_updated_at();

-- ============================================================
--  Row Level Security (RLS)
-- ============================================================
alter table public.profiles    enable row level security;
alter table public.admins      enable row level security;
alter table public.matches     enable row level security;
alter table public.predictions enable row level security;

-- profiles: todos leem (p/ ranking); cada um edita só o seu
drop policy if exists "profiles_read"   on public.profiles;
drop policy if exists "profiles_insert" on public.profiles;
drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_read"   on public.profiles for select using (true);
create policy "profiles_insert" on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy "profiles_update" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- admins: usuário logado só consegue ler (pra saber se é admin)
drop policy if exists "admins_read" on public.admins;
create policy "admins_read" on public.admins for select to authenticated using (true);

-- matches: leitura pública; só admin altera (lançar placar)
drop policy if exists "matches_read"   on public.matches;
drop policy if exists "matches_update" on public.matches;
create policy "matches_read" on public.matches for select using (true);
create policy "matches_update" on public.matches for update to authenticated
  using     (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check(exists (select 1 from public.admins a where a.user_id = auth.uid()));

-- predictions: vejo os meus sempre, e os dos outros só após o jogo terminar
drop policy if exists "pred_read"   on public.predictions;
drop policy if exists "pred_insert" on public.predictions;
drop policy if exists "pred_update" on public.predictions;
create policy "pred_read" on public.predictions for select to authenticated using (
  auth.uid() = user_id
  or exists (select 1 from public.matches m where m.id = match_id and m.status = 'finished')
);
-- só dá pra palpitar/editar ANTES do jogo começar
create policy "pred_insert" on public.predictions for insert to authenticated with check (
  auth.uid() = user_id
  and exists (select 1 from public.matches m
              where m.id = match_id and (m.match_date is null or m.match_date > now()))
);
create policy "pred_update" on public.predictions for update to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.matches m
                where m.id = match_id and (m.match_date is null or m.match_date > now()))
  );

-- Permissões da view de ranking
grant select on public.leaderboard to anon, authenticated;


-- Jogos da fase de grupos da Copa 2026 (gerado por scripts/gen-seed.mjs)
-- Rode DEPOIS do schema.sql. Idempotente: limpa e recria os jogos.
truncate table public.matches restart identity cascade;

insert into public.matches
  (group_code, matchday, home_team, away_team, home_iso, away_iso, match_date)
values
('A', 1, 'México', 'África do Sul', 'mx', 'za', '2026-06-11 19:00:00+00'),
('A', 1, 'Coreia do Sul', 'República Tcheca', 'kr', 'cz', '2026-06-11 22:00:00+00'),
('A', 2, 'México', 'Coreia do Sul', 'mx', 'kr', '2026-06-17 19:00:00+00'),
('A', 2, 'República Tcheca', 'África do Sul', 'cz', 'za', '2026-06-17 22:00:00+00'),
('A', 3, 'México', 'República Tcheca', 'mx', 'cz', '2026-06-25 19:00:00+00'),
('A', 3, 'África do Sul', 'Coreia do Sul', 'za', 'kr', '2026-06-25 22:00:00+00'),
('B', 1, 'Canadá', 'Bósnia e Herzegovina', 'ca', 'ba', '2026-06-11 19:00:00+00'),
('B', 1, 'Catar', 'Suíça', 'qa', 'ch', '2026-06-11 22:00:00+00'),
('B', 2, 'Canadá', 'Catar', 'ca', 'qa', '2026-06-17 19:00:00+00'),
('B', 2, 'Suíça', 'Bósnia e Herzegovina', 'ch', 'ba', '2026-06-17 22:00:00+00'),
('B', 3, 'Canadá', 'Suíça', 'ca', 'ch', '2026-06-25 19:00:00+00'),
('B', 3, 'Bósnia e Herzegovina', 'Catar', 'ba', 'qa', '2026-06-25 22:00:00+00'),
('C', 1, 'Brasil', 'Marrocos', 'br', 'ma', '2026-06-13 19:00:00+00'),
('C', 1, 'Haiti', 'Escócia', 'ht', 'gb-sct', '2026-06-13 22:00:00+00'),
('C', 2, 'Brasil', 'Haiti', 'br', 'ht', '2026-06-19 19:00:00+00'),
('C', 2, 'Escócia', 'Marrocos', 'gb-sct', 'ma', '2026-06-19 22:00:00+00'),
('C', 3, 'Brasil', 'Escócia', 'br', 'gb-sct', '2026-06-24 19:00:00+00'),
('C', 3, 'Marrocos', 'Haiti', 'ma', 'ht', '2026-06-24 22:00:00+00'),
('D', 1, 'Estados Unidos', 'Paraguai', 'us', 'py', '2026-06-12 19:00:00+00'),
('D', 1, 'Austrália', 'Turquia', 'au', 'tr', '2026-06-12 22:00:00+00'),
('D', 2, 'Estados Unidos', 'Austrália', 'us', 'au', '2026-06-18 19:00:00+00'),
('D', 2, 'Turquia', 'Paraguai', 'tr', 'py', '2026-06-18 22:00:00+00'),
('D', 3, 'Estados Unidos', 'Turquia', 'us', 'tr', '2026-06-24 19:00:00+00'),
('D', 3, 'Paraguai', 'Austrália', 'py', 'au', '2026-06-24 22:00:00+00'),
('E', 1, 'Alemanha', 'Curaçao', 'de', 'cw', '2026-06-13 19:00:00+00'),
('E', 1, 'Costa do Marfim', 'Equador', 'ci', 'ec', '2026-06-13 22:00:00+00'),
('E', 2, 'Alemanha', 'Costa do Marfim', 'de', 'ci', '2026-06-18 19:00:00+00'),
('E', 2, 'Equador', 'Curaçao', 'ec', 'cw', '2026-06-18 22:00:00+00'),
('E', 3, 'Alemanha', 'Equador', 'de', 'ec', '2026-06-26 19:00:00+00'),
('E', 3, 'Curaçao', 'Costa do Marfim', 'cw', 'ci', '2026-06-26 22:00:00+00'),
('F', 1, 'Holanda', 'Japão', 'nl', 'jp', '2026-06-14 19:00:00+00'),
('F', 1, 'Suécia', 'Tunísia', 'se', 'tn', '2026-06-14 22:00:00+00'),
('F', 2, 'Holanda', 'Suécia', 'nl', 'se', '2026-06-20 19:00:00+00'),
('F', 2, 'Tunísia', 'Japão', 'tn', 'jp', '2026-06-20 22:00:00+00'),
('F', 3, 'Holanda', 'Tunísia', 'nl', 'tn', '2026-06-26 19:00:00+00'),
('F', 3, 'Japão', 'Suécia', 'jp', 'se', '2026-06-26 22:00:00+00'),
('G', 1, 'Bélgica', 'Egito', 'be', 'eg', '2026-06-14 19:00:00+00'),
('G', 1, 'Irã', 'Nova Zelândia', 'ir', 'nz', '2026-06-14 22:00:00+00'),
('G', 2, 'Bélgica', 'Irã', 'be', 'ir', '2026-06-20 19:00:00+00'),
('G', 2, 'Nova Zelândia', 'Egito', 'nz', 'eg', '2026-06-20 22:00:00+00'),
('G', 3, 'Bélgica', 'Nova Zelândia', 'be', 'nz', '2026-06-25 19:00:00+00'),
('G', 3, 'Egito', 'Irã', 'eg', 'ir', '2026-06-25 22:00:00+00'),
('H', 1, 'Espanha', 'Cabo Verde', 'es', 'cv', '2026-06-15 19:00:00+00'),
('H', 1, 'Arábia Saudita', 'Uruguai', 'sa', 'uy', '2026-06-15 22:00:00+00'),
('H', 2, 'Espanha', 'Arábia Saudita', 'es', 'sa', '2026-06-21 19:00:00+00'),
('H', 2, 'Uruguai', 'Cabo Verde', 'uy', 'cv', '2026-06-21 22:00:00+00'),
('H', 3, 'Espanha', 'Uruguai', 'es', 'uy', '2026-06-23 19:00:00+00'),
('H', 3, 'Cabo Verde', 'Arábia Saudita', 'cv', 'sa', '2026-06-23 22:00:00+00'),
('I', 1, 'França', 'Senegal', 'fr', 'sn', '2026-06-15 19:00:00+00'),
('I', 1, 'Iraque', 'Noruega', 'iq', 'no', '2026-06-15 22:00:00+00'),
('I', 2, 'França', 'Iraque', 'fr', 'iq', '2026-06-21 19:00:00+00'),
('I', 2, 'Noruega', 'Senegal', 'no', 'sn', '2026-06-21 22:00:00+00'),
('I', 3, 'França', 'Noruega', 'fr', 'no', '2026-06-23 19:00:00+00'),
('I', 3, 'Senegal', 'Iraque', 'sn', 'iq', '2026-06-23 22:00:00+00'),
('J', 1, 'Argentina', 'Argélia', 'ar', 'dz', '2026-06-16 19:00:00+00'),
('J', 1, 'Áustria', 'Jordânia', 'at', 'jo', '2026-06-16 22:00:00+00'),
('J', 2, 'Argentina', 'Áustria', 'ar', 'at', '2026-06-22 19:00:00+00'),
('J', 2, 'Jordânia', 'Argélia', 'jo', 'dz', '2026-06-22 22:00:00+00'),
('J', 3, 'Argentina', 'Jordânia', 'ar', 'jo', '2026-06-27 19:00:00+00'),
('J', 3, 'Argélia', 'Áustria', 'dz', 'at', '2026-06-27 22:00:00+00'),
('K', 1, 'Portugal', 'Colômbia', 'pt', 'co', '2026-06-16 19:00:00+00'),
('K', 1, 'Uzbequistão', 'RD do Congo', 'uz', 'cd', '2026-06-16 22:00:00+00'),
('K', 2, 'Portugal', 'Uzbequistão', 'pt', 'uz', '2026-06-22 19:00:00+00'),
('K', 2, 'RD do Congo', 'Colômbia', 'cd', 'co', '2026-06-22 22:00:00+00'),
('K', 3, 'Portugal', 'RD do Congo', 'pt', 'cd', '2026-06-27 19:00:00+00'),
('K', 3, 'Colômbia', 'Uzbequistão', 'co', 'uz', '2026-06-27 22:00:00+00'),
('L', 1, 'Inglaterra', 'Croácia', 'gb-eng', 'hr', '2026-06-17 19:00:00+00'),
('L', 1, 'Gana', 'Panamá', 'gh', 'pa', '2026-06-17 22:00:00+00'),
('L', 2, 'Inglaterra', 'Gana', 'gb-eng', 'gh', '2026-06-23 19:00:00+00'),
('L', 2, 'Panamá', 'Croácia', 'pa', 'hr', '2026-06-23 22:00:00+00'),
('L', 3, 'Inglaterra', 'Panamá', 'gb-eng', 'pa', '2026-06-27 19:00:00+00'),
('L', 3, 'Croácia', 'Gana', 'hr', 'gh', '2026-06-27 22:00:00+00');
