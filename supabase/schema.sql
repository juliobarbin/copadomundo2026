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
