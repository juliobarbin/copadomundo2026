// Gera supabase/seed.sql com os 72 jogos da fase de grupos da Copa 2026.
// Uso: node scripts/gen-seed.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// [nome, isoFlagcdn]
const groups = {
  A: [['México','mx'],['África do Sul','za'],['Coreia do Sul','kr'],['República Tcheca','cz']],
  B: [['Canadá','ca'],['Bósnia e Herzegovina','ba'],['Catar','qa'],['Suíça','ch']],
  C: [['Brasil','br'],['Marrocos','ma'],['Haiti','ht'],['Escócia','gb-sct']],
  D: [['Estados Unidos','us'],['Paraguai','py'],['Austrália','au'],['Turquia','tr']],
  E: [['Alemanha','de'],['Curaçao','cw'],['Costa do Marfim','ci'],['Equador','ec']],
  F: [['Holanda','nl'],['Japão','jp'],['Suécia','se'],['Tunísia','tn']],
  G: [['Bélgica','be'],['Egito','eg'],['Irã','ir'],['Nova Zelândia','nz']],
  H: [['Espanha','es'],['Cabo Verde','cv'],['Arábia Saudita','sa'],['Uruguai','uy']],
  I: [['França','fr'],['Senegal','sn'],['Iraque','iq'],['Noruega','no']],
  J: [['Argentina','ar'],['Argélia','dz'],['Áustria','at'],['Jordânia','jo']],
  K: [['Portugal','pt'],['Colômbia','co'],['Uzbequistão','uz'],['RD do Congo','cd']],
  L: [['Inglaterra','gb-eng'],['Croácia','hr'],['Gana','gh'],['Panamá','pa']],
};

// Confrontos por rodada (índices do array do grupo).
// MD1: 0v1, 2v3 | MD2: 0v2, 3v1 | MD3: 0v3, 1v2
// Escolhido p/ honrar jogos conhecidos (México x África do Sul, Brasil x Marrocos/Haiti/Escócia).
const fixtures = [
  { md: 1, pairs: [[0,1],[2,3]] },
  { md: 2, pairs: [[0,2],[3,1]] },
  { md: 3, pairs: [[0,3],[1,2]] },
];

// Datas (UTC) por grupo e rodada. Aproximadas, exceto jogos oficiais conhecidos.
// índice = ordem dos grupos A..L
const codes = Object.keys(groups);
// dia de junho por [grupo][rodada]
const dayByGroup = {
  A: [11, 17, 25], B: [11, 17, 25], C: [13, 19, 24], D: [12, 18, 24],
  E: [13, 18, 26], F: [14, 20, 26], G: [14, 20, 25], H: [15, 21, 23],
  I: [15, 21, 23], J: [16, 22, 27], K: [16, 22, 27], L: [17, 23, 27],
};

const esc = (s) => s.replace(/'/g, "''");
const rows = [];

for (const code of codes) {
  const teams = groups[code];
  fixtures.forEach((f, ri) => {
    const day = dayByGroup[code][ri];
    f.pairs.forEach(([h, a], pi) => {
      const hour = pi === 0 ? 19 : 22; // dois horários por dia (UTC)
      const date = `2026-06-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:00:00+00`;
      const [hn, hi] = teams[h];
      const [an, ai] = teams[a];
      rows.push(
        `('${code}', ${f.md}, '${esc(hn)}', '${esc(an)}', '${hi}', '${ai}', '${date}')`
      );
    });
  });
}

const sql = `-- Jogos da fase de grupos da Copa 2026 (gerado por scripts/gen-seed.mjs)
-- Rode DEPOIS do schema.sql. Idempotente: limpa e recria os jogos.
truncate table public.matches restart identity cascade;

insert into public.matches
  (group_code, matchday, home_team, away_team, home_iso, away_iso, match_date)
values
${rows.join(',\n')};
`;

mkdirSync(join(root, 'supabase'), { recursive: true });
writeFileSync(join(root, 'supabase', 'seed.sql'), sql);
console.log(`OK: ${rows.length} jogos -> supabase/seed.sql`);
