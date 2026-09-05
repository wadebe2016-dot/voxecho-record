/**
 * Peuple une base d'essai sans rien savoir de son schéma — CLAUDE.md §9.30.
 *
 * Une liste de colonnes écrite à la main vieillit mal : celle du premier jet
 * s'est cassée au lot suivant, quand `case_reference` est devenue obligatoire.
 * Ce peupleur lit donc le schéma réel de la base d'essai — colonnes
 * obligatoires, types, clés étrangères — et fabrique une ligne par table.
 *
 * Le contenu n'a aucune importance : c'est la **présence** d'une ligne qui
 * fait échouer un `ADD COLUMN NOT NULL` sans défaut, et c'est précisément ce
 * qu'on cherche à éprouver.
 */
import { execFileSync } from 'node:child_process';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL absente.');
  process.exit(1);
}

const cible = (() => {
  const analysee = new URL(url);
  analysee.search = '';
  return analysee.toString();
})();

/** Exécute du SQL et rend les lignes, en tabulé. */
function interroger(sql) {
  const sortie = execFileSync('psql', [cible, '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', sql], {
    encoding: 'utf8',
  });
  return sortie
    .split('\n')
    .filter((ligne) => ligne.trim() !== '')
    .map((ligne) => ligne.split('\t'));
}

function executer(sql) {
  execFileSync('psql', [cible, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], { stdio: 'pipe' });
}

const tables = interroger(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    AND table_name NOT LIKE '_prisma%'
  ORDER BY table_name
`).map(([nom]) => nom);

/** Colonnes à renseigner : obligatoires et sans valeur par défaut. */
function colonnesObligatoires(table) {
  return interroger(`
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = '${table}'
      AND is_nullable = 'NO' AND column_default IS NULL
    ORDER BY ordinal_position
  `);
}

/** Clés étrangères de la table : colonne → table visée, colonne visée. */
function clesEtrangeres(table) {
  return interroger(`
    SELECT kcu.column_name, ccu.table_name, ccu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      AND tc.table_name = '${table}'
  `);
}

/** Première valeur d'un type énuméré : n'importe laquelle fait l'affaire. */
function premiereValeurEnum(type) {
  const [ligne] = interroger(
    `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = '${type}' ORDER BY e.enumsortorder LIMIT 1`,
  );
  return ligne?.[0];
}

/** Une valeur plausible pour un type, sans chercher à être réaliste. */
function valeurPour(type, udt) {
  switch (type) {
    case 'uuid':
      return 'gen_random_uuid()';
    case 'integer':
    case 'bigint':
    case 'smallint':
      return '1';
    case 'numeric':
    case 'double precision':
      return '1';
    case 'boolean':
      return 'false';
    case 'timestamp without time zone':
    case 'timestamp with time zone':
      return 'now()';
    case 'jsonb':
    case 'json':
      return `'{}'::${type}`;
    case 'USER-DEFINED': {
      const valeur = premiereValeurEnum(udt);
      return valeur === undefined ? "'inconnu'" : `'${valeur}'::"${udt}"`;
    }
    default:
      return "'essai'";
  }
}

/**
 * Insère une ligne par table, en plusieurs passes : une table dont la clé
 * étrangère n'est pas encore satisfaite réussira au tour suivant. Plus simple
 * qu'un tri topologique, et suffisant sur une dizaine de tables.
 */
let restantes = [...tables];
const peuplees = [];

for (let passe = 0; passe < 6 && restantes.length > 0; passe += 1) {
  const echouees = [];

  for (const table of restantes) {
    const colonnes = colonnesObligatoires(table);
    const fks = new Map(clesEtrangeres(table).map(([col, cible_, colCible]) => [col, [cible_, colCible]]));

    const noms = [];
    const valeurs = [];
    let possible = true;

    for (const [nom, type, udt] of colonnes) {
      noms.push(`"${nom}"`);
      const fk = fks.get(nom);
      if (fk) {
        // Référencer une ligne déjà insérée plutôt qu'en inventer une.
        const [tableCible, colonneCible] = fk;
        const [existante] = interroger(
          `SELECT "${colonneCible}" FROM "${tableCible}" LIMIT 1`,
        );
        if (existante === undefined) {
          possible = false;
          break;
        }
        valeurs.push(`'${existante[0]}'`);
      } else {
        valeurs.push(valeurPour(type, udt));
      }
    }

    if (!possible) {
      echouees.push(table);
      continue;
    }

    try {
      executer(
        noms.length === 0
          ? `INSERT INTO "${table}" DEFAULT VALUES`
          : `INSERT INTO "${table}" (${noms.join(', ')}) VALUES (${valeurs.join(', ')})`,
      );
      peuplees.push(table);
    } catch {
      // Contrainte d'unicité, déclencheur, ordre encore insatisfait : on
      // réessaiera au tour suivant, et le silence final dira ce qui manque.
      echouees.push(table);
    }
  }

  restantes = echouees;
}

console.log(`   ${peuplees.length} table(s) peuplée(s) : ${peuplees.join(', ')}`);
if (restantes.length > 0) {
  // Ce n'est pas un échec : certaines tables sont protégées en écriture
  // (journal append-only) ou dépendent d'un état qu'on ne fabrique pas.
  console.log(`   laissées vides : ${restantes.join(', ')}`);
}
